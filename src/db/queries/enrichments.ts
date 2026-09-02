import { and, asc, desc, eq } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as t from '@/db/schema';

/**
 * Reading an append-only Enrichment table (SPEC §3.4, §7).
 *
 * `recordEnrichment` writes a **new** `enrichment` row for every dated call on
 * the same subject and never updates one, because a value row's
 * `enrichment_id` is what a Citation resolves through: overwriting it would
 * move a number underneath the sentence that argued from it. That makes the
 * value tables a pile of generations, and it puts the whole burden on the
 * read — which two readers were not carrying.
 *
 * - `assembleScoringInput` read **every** `news_item` for an entity, so a
 *   second Enrichment doubled the article count and the flag-weighted figure
 *   behind the media signal Criterion.
 * - It read **every** `country_indicator` for a country with no `ORDER BY`,
 *   and `countryResilience` folds them into a `Map` by indicator code — so
 *   after a re-enrich, which generation's value and year reached the Score
 *   depended on Postgres row order. That is the third time in this build a
 *   query with no total order has decided an answer (`src/upstream/call.ts`
 *   and `src/tools/catalog/reads.ts` are the two that were already fixed).
 *
 * So every value read lives here, and every one of them applies the same two
 * rules: **the latest generation only**, and an **explicit total order**.
 * `generation` is the ordering key rather than `fetched_at`, because
 * `fetched_at` comes from the upstream body — a replay against a warm cache
 * writes two generations carrying the same instant, and a seeded fixture
 * writes a whole file's rows in one statement. `id` is the tiebreak that makes
 * the order total even then, exactly as `readCache` uses it.
 */

/** The latest generation of one Enrichment subject, or nothing fetched yet. */
async function latestEnrichmentId(
  db: Database,
  args: {
    source: (typeof t.enrichmentSource.enumValues)[number];
    subjectKind: (typeof t.enrichmentSubjectKind.enumValues)[number];
    subjectKey: string;
  },
): Promise<string | undefined> {
  const [row] = await db
    .select({ id: t.enrichment.id })
    .from(t.enrichment)
    .where(
      and(
        eq(t.enrichment.source, args.source),
        eq(t.enrichment.subjectKind, args.subjectKind),
        eq(t.enrichment.subjectKey, args.subjectKey),
      ),
    )
    .orderBy(desc(t.enrichment.generation), desc(t.enrichment.id))
    .limit(1);
  return row?.id;
}

/**
 * The articles the **latest** `negativeNews` call returned for one Profile.
 *
 * Not every article ever stored for it: the Criterion weighs a count, and a
 * count over two generations is a count of how many times we asked.
 */
export async function latestNewsItems(
  db: Database,
  entityId: string,
): Promise<(typeof t.newsItem.$inferSelect)[]> {
  const enrichmentId = await latestEnrichmentId(db, {
    source: 'sayari_negative_news',
    subjectKind: 'entity',
    subjectKey: entityId,
  });
  if (!enrichmentId) return [];

  return db
    .select()
    .from(t.newsItem)
    .where(and(eq(t.newsItem.enrichmentId, enrichmentId), eq(t.newsItem.entityId, entityId)))
    .orderBy(asc(t.newsItem.id));
}

/**
 * The **latest generation per indicator** for one country (SPEC §9.2).
 *
 * Per indicator rather than per country, because each of the six is its own
 * Enrichment subject (`<country>:<code>`) and they are re-fetched together but
 * counted separately — a call that failed for one indicator leaves that one a
 * generation behind, and the other five are still the newest we hold.
 *
 * Every row of the winning generation is returned rather than one per code:
 * `mrnev=1` returns a single observation today, and dropping rows here would
 * silently decide something the Criterion is entitled to decide.
 */
export async function latestCountryIndicators(
  db: Database,
  country: string,
): Promise<(typeof t.countryIndicator.$inferSelect)[]> {
  const rows = await db
    .select({ indicator: t.countryIndicator, enrichmentId: t.enrichment.id })
    .from(t.countryIndicator)
    .innerJoin(t.enrichment, eq(t.enrichment.id, t.countryIndicator.enrichmentId))
    .where(eq(t.countryIndicator.country, country))
    .orderBy(
      asc(t.countryIndicator.indicatorCode),
      desc(t.enrichment.generation),
      desc(t.enrichment.id),
      asc(t.countryIndicator.id),
    );

  const winner = new Map<string, string>();
  for (const row of rows) {
    if (!winner.has(row.indicator.indicatorCode)) {
      winner.set(row.indicator.indicatorCode, row.enrichmentId);
    }
  }
  return rows
    .filter((row) => winner.get(row.indicator.indicatorCode) === row.enrichmentId)
    .map((row) => row.indicator);
}

/**
 * One coordinate per geocoded subject — the Program map's fallback layer.
 *
 * The subject is a Supplier id (SPEC §7.1: geocoding is for Plants and
 * unresolved rows only), and re-geocoding the same address writes a new
 * generation rather than replacing the old one, so this collapses to the
 * latest before the caller ever sees two.
 */
export async function latestGeocodePoints(
  db: Database,
): Promise<{ supplierKey: string; lat: number | null; lon: number | null }[]> {
  const rows = await db
    // The subject of an address Enrichment is a Supplier id, so it is named
    // for what it is rather than for the column it is stored in.
    .select({
      supplierKey: t.enrichment.subjectKey,
      lat: t.geocode.lat,
      lon: t.geocode.lon,
    })
    .from(t.geocode)
    .innerJoin(t.enrichment, eq(t.enrichment.id, t.geocode.enrichmentId))
    .where(eq(t.enrichment.subjectKind, 'address'))
    .orderBy(
      asc(t.enrichment.subjectKey),
      desc(t.enrichment.generation),
      desc(t.enrichment.id),
      asc(t.geocode.id),
    );

  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.supplierKey)) return false;
    seen.add(row.supplierKey);
    return true;
  });
}

/**
 * A Supplier's Enrichments, with their **age already computed**.
 *
 * The age is computed here rather than in the component for two reasons, and
 * only one of them is the linter: reading a clock during render is not
 * idempotent, and a page that re-renders would show a different number for the
 * same row. Doing it in the query means one clock read per request.
 *
 * The age itself **reports and never acts** (SPEC §7.2): staleness forces the
 * caveat line rather than blocking anything, and there is no TTL and no
 * background refresh — a background TTL would spend credits on page views.
 */
export type EnrichmentRow = typeof t.enrichment.$inferSelect & {
  ageDays: number;
  /** Over 30 days: old enough that a sentence citing it owes a caveat. */
  needsCaveat: boolean;
};

/**
 * **Every generation of every Enrichment for one subject**, newest first.
 *
 * Named for the history rather than for the subject because the distinction is
 * the whole point of this module: the readers above answer *what do we know*
 * and take the latest generation only, while this one answers *what did we
 * fetch, and when* — the Supplier page's own words — and a fetch log that
 * hid the earlier fetches would be a log of the last one. Two generations of
 * the same source render as two rows with two age badges, which is the honest
 * rendering of having asked twice.
 */
export async function loadEnrichmentHistory(
  db: Database,
  subjectKey: string,
): Promise<EnrichmentRow[]> {
  const rows = await db
    .select()
    .from(t.enrichment)
    .where(eq(t.enrichment.subjectKey, subjectKey))
    // Newest first, and total: `fetched_at` alone ties whenever a warm cache
    // served two generations the same body.
    .orderBy(desc(t.enrichment.fetchedAt), desc(t.enrichment.generation), desc(t.enrichment.id));

  const now = Date.now();
  return rows.map((row) => {
    const ageDays = Math.floor((now - row.fetchedAt.getTime()) / 86_400_000);
    return { ...row, ageDays, needsCaveat: ageDays >= 30 };
  });
}

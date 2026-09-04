import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as t from '@/db/schema';
import { derivedId } from '@/db/derived-id';
import {
  ownersOf,
  parseRelationships,
  sharePercentageOf,
  type ParsedEdge,
} from '@/domain/parse-relationships';
import { upwardOwnershipTypes } from '@/domain/relationships';
import {
  FAMILY_TRAVERSAL_LIMIT,
  OWNERSHIP_EXPOSURE_RISK_CATEGORIES,
  OWNERSHIP_EXPOSURE_TRAVERSAL_LIMIT,
  WATCHLIST_TRAVERSAL_LIMIT,
  WATCHLIST_TRAVERSAL_MAX_DEPTH,
} from '@/config/constants';
import { COUNTRY_INDICATORS } from '@/domain/scoring/anchors';
import { chooseHtsLine } from '@/domain/hs-code';
import type { EntitySource, FamilyMemberRisk } from '@/domain/family';
import { nearestPlant, type PlantPoint } from '@/domain/geo';
import { parseRiskObject } from '@/domain/scoring/risk-factors';
import {
  ownershipHopDepth,
  summarisePath,
  terminalEntityOf,
  writeGraphPaths,
  type GraphPathWrite,
  type PathHop,
} from './family-members';
import { upsertEntity } from './resolve';
import type { Upstream, UpstreamResult } from '@/upstream';
import type { SayariEntity, SayariTraversalPath } from '@/upstream/projections/sayari';

/**
 * The enrichment fan-out (SPEC §7, §8).
 *
 * Six sources per accepted Profile — or per country and per HS line, which are
 * **shared across Suppliers** and are exactly why data confidence cannot be a
 * row count on the Supplier.
 *
 * **Deterministic: no model runs here.** That is why this Job needs no fixture
 * (SPEC §19.2) and why it calls `src/upstream/call()` directly rather than
 * going through the tool registry — the registry is a *model-facing* catalog.
 *
 * Two rules apply to all six:
 *
 * 1. `fetched_at` is displayed with an age badge, and an aged Enrichment forces
 *    the caveat line rather than blocking anything. **No TTL, no background
 *    refresh** — a background TTL would spend credits on page views.
 * 2. Tariff trade-action flags are **authored, never computed**: they key on
 *    facts this app does not have.
 */

export type EnrichContext = {
  db: Database;
  upstream: Upstream;
  jobId?: string | undefined;
};

/**
 * Records one dated call as an `enrichment` row — the Citation target.
 *
 * Exported because the Deep Traversal writes Enrichments too, and CONTEXT is
 * explicit that what makes an Enrichment is *the dated call*, not where the
 * answer came from — so a walk of the ownership graph is one for exactly the
 * same reason the automatic family read is. Two functions deriving an
 * `enrichment.id` would be two answers to *which row does a Citation point at*.
 */
export async function recordEnrichment(
  ctx: EnrichContext,
  args: {
    source: (typeof t.enrichmentSource.enumValues)[number];
    subjectKind: (typeof t.enrichmentSubjectKind.enumValues)[number];
    subjectKey: string;
    requestParams: Record<string, unknown>;
    result: UpstreamResult<unknown>;
  },
): Promise<string> {
  // Append-only: a re-fetch writes a new row for the same subject, so the
  // generation is what separates them. Counted, not timestamped, so two runs an
  // hour apart agree.
  const [{ generation }] = (await ctx.db
    .select({ generation: sql<number>`count(*)::int` })
    .from(t.enrichment)
    .where(
      and(
        eq(t.enrichment.source, args.source),
        eq(t.enrichment.subjectKind, args.subjectKind),
        eq(t.enrichment.subjectKey, args.subjectKey),
      ),
    )) as [{ generation: number }];

  const id = derivedId(
    'enrichment',
    `${args.source}:${args.subjectKind}:${args.subjectKey}`,
    generation,
  );

  /**
   * **Two Jobs enriching the same shared subject race here, and one of them
   * loses.** Country and tariff Enrichments are shared across Suppliers by
   * design, the id is derived from the subject plus a counted generation, and
   * the worker runs four Jobs at once — so two Suppliers in the same country
   * both read generation 0, both derive the same id, and the second insert
   * violates the primary key. That threw, and a throw is `failed`: the whole
   * enrichment of an unrelated Supplier died on a row another Supplier had
   * already written correctly.
   *
   * A conflict here is not a collision of two different facts. The id encodes
   * source, subject and generation, so the row that beat us is **the row we
   * were about to write** — same subject, same generation, and (because
   * `upstream_response` is a cache) overwhelmingly the same fetched body. Its
   * id is the right Citation target, so we take it and carry on.
   *
   * `onConflictDoNothing` rather than a transaction or a lock: serialising
   * every shared-subject write would put a queue in front of the one thing
   * concurrency 4 exists to speed up, to prevent something that is already a
   * no-op when it happens.
   */
  const [row] = await ctx.db
    .insert(t.enrichment)
    .values({
      id,
      source: args.source,
      subjectKind: args.subjectKind,
      subjectKey: args.subjectKey,
      requestParams: args.requestParams as never,
      // Stored, not only hashed into the id: it is the order every
      // latest-generation read in `db/queries/enrichments.ts` runs on, and
      // `fetched_at` cannot stand in for it on a warm cache.
      generation,
      upstreamResponseId: args.result.upstreamResponseId,
      fetchedAt: args.result.fetchedAt,
      jobId: ctx.jobId ?? null,
    })
    .onConflictDoNothing({ target: t.enrichment.id })
    .returning({ id: t.enrichment.id });

  return row?.id ?? id;
}

// ── 1. Negative news ─────────────────────────────────────────────────────────

/**
 * **The input is the resolved legal name, never the roster trade name.**
 *
 * The endpoint takes a bare name, so disambiguation is ours. Running it on
 * "Bosch" would return articles about a company we have not identified, and a
 * zero result would be meaningless in a way that looks exactly like a clean
 * record.
 *
 * ## Why the articles stay append-only, and the read is what changed
 *
 * A second Enrichment used to **double the article count**: these rows carried
 * a random id and no conflict target, and `assembleScoringInput` read every
 * `news_item` for the entity regardless of which Enrichment fetched it. Nine
 * Yazaki articles became eighteen, and the flag-weighted figure behind the
 * media signal Criterion doubled with them (SPEC §9.2).
 *
 * Deduping on a natural key of the article — title plus url — was the other
 * way to fix it, and it would have broken `recordEnrichment`'s append-only
 * generation model: the surviving row would carry the **first** Enrichment's
 * id for ever, so the Citation on a sentence written from the second fetch
 * would point at a dated call that did not return that article, and a body
 * that dropped an article could never be distinguished from one we had not
 * re-read. An Enrichment is *a dated call and what it returned*, so each
 * generation keeps its own rows and the reader takes the latest
 * (`latestNewsItems`).
 *
 * The id is derived instead of random, from the Enrichment and the article's
 * position in the body, so **writing the same generation twice is a no-op**
 * rather than a double — the case `recordEnrichment` documents, where two Jobs
 * race on one subject and the loser adopts the winner's row. Position rather
 * than content, because a feed that genuinely returns the same headline twice
 * is reporting two articles, and this is not the place to overrule it.
 */
export async function enrichNegativeNews(
  ctx: EnrichContext,
  args: { entityId: string; resolvedLegalName: string },
): Promise<{ enrichmentId: string; articleCount: number }> {
  const result = await ctx.upstream.sayari.negativeNews({ name: args.resolvedLegalName });
  const enrichmentId = await recordEnrichment(ctx, {
    source: 'sayari_negative_news',
    subjectKind: 'entity',
    subjectKey: args.entityId,
    requestParams: { resolvedLegalName: args.resolvedLegalName },
    result,
  });

  const articles = result.data.data ?? [];
  for (const [ordinal, article] of articles.entries()) {
    await ctx.db
      .insert(t.newsItem)
      .values({
        id: derivedId('news_item', `${enrichmentId}:${args.entityId}`, ordinal),
        enrichmentId,
        entityId: args.entityId,
        title: article.title ?? '(untitled)',
        sourceName: article.source ?? null,
        url: article.url ?? null,
        publishedAt: parseDate(article.published),
        riskFlags: (article.risk_flags ?? null) as never,
      })
      .onConflictDoNothing({ target: t.newsItem.id });
  }
  return { enrichmentId, articleCount: articles.length };
}

// ── 2. World Bank ────────────────────────────────────────────────────────────

/**
 * Shared across every Supplier in the country — hence six calls, not fifty.
 *
 * Each indicator is its own Enrichment subject (`<country>:<code>`), so a
 * re-fetch appends a generation per indicator and the scoring read takes the
 * newest of each (`latestCountryIndicators`). Nothing is updated in place:
 * the Score cites the `country_indicator` row it was computed from.
 */
export async function enrichCountry(
  ctx: EnrichContext,
  args: { country: string },
): Promise<{ enrichmentIds: string[]; indicatorsReturned: number }> {
  const enrichmentIds: string[] = [];
  let returned = 0;

  for (const spec of COUNTRY_INDICATORS) {
    const result = await ctx.upstream.worldbank.indicator({
      country: args.country,
      indicator: spec.code,
    });
    const enrichmentId = await recordEnrichment(ctx, {
      source: 'world_bank',
      subjectKind: 'country',
      subjectKey: `${args.country}:${spec.code}`,
      requestParams: { country: args.country, indicator: spec.code, mrnev: 1 },
      result,
    });
    enrichmentIds.push(enrichmentId);

    const rows = Array.isArray(result.data) && Array.isArray(result.data[1]) ? result.data[1] : [];
    for (const row of rows) {
      if (row.value == null) continue;
      returned += 1;
      await ctx.db.insert(t.countryIndicator).values({
        enrichmentId,
        country: args.country,
        indicatorCode: spec.code,
        indicatorLabel: spec.label,
        year: row.date ? Number(row.date) : null,
        value: row.value,
        // `.SC_LB` / `.SC_UB` where the indicator carries them. Overlapping
        // bands are not a real difference, and the UI renders the band.
        lowerBound: null,
        upperBound: null,
      });
    }
  }
  return { enrichmentIds, indicatorsReturned: returned };
}

// ── 3. GLEIF ─────────────────────────────────────────────────────────────────

/**
 * The exact-LEI join, stored as a `lei_record` per generation.
 *
 * **Nothing in `src/` reads this table yet** — the LEI witness Discriminator
 * runs against the live join during a Match, and the Supplier page renders the
 * `enrichment` row rather than the record. Audited and said out loud rather
 * than left to be discovered: a reader added later belongs in
 * `db/queries/enrichments.ts` with the same latest-generation rule as its
 * neighbours, because these rows accumulate exactly like the ones that were
 * being double-counted.
 */
export async function enrichLei(
  ctx: EnrichContext,
  args: { entityId: string; lei: string },
): Promise<{ enrichmentId: string } | undefined> {
  const result = await ctx.upstream.gleif.joinLei({ lei: args.lei });
  const record = result.data.data;
  if (!record) return undefined;

  const enrichmentId = await recordEnrichment(ctx, {
    source: 'gleif',
    subjectKind: 'entity',
    subjectKey: args.entityId,
    requestParams: { lei: args.lei },
    result,
  });

  const entity = record.attributes?.entity;
  await ctx.db.insert(t.leiRecord).values({
    enrichmentId,
    lei: args.lei,
    legalName: entity?.legalName?.name ?? '(unnamed)',
    legalAddressLine: entity?.legalAddress?.addressLines?.join(', ') ?? null,
    legalCity: entity?.legalAddress?.city ?? null,
    legalPostcode: entity?.legalAddress?.postalCode ?? null,
    legalCountry: entity?.legalAddress?.country ?? null,
    status: entity?.status ?? null,
    registrationStatus: record.attributes?.registration?.status ?? null,
  });
  return { enrichmentId };
}

// ── 4. Tariffs ───────────────────────────────────────────────────────────────

/**
 * Shared across Suppliers, per HS line.
 *
 * The (origin → MEX) duty is **fetched and rendered beside** the scored figure
 * and is never scored, because the Program stores one importer and the Mexican
 * Plant makes that an explicit proxy.
 *
 * Like `lei_record`, **nothing in `src/` reads `tariff_line`**: the rate this
 * returns goes straight into the Criterion, and the row exists so a sentence
 * can cite the fetch it came from. Same rule if that changes — the reader goes
 * in `db/queries/enrichments.ts` and takes the latest generation.
 */
export async function enrichTariff(
  ctx: EnrichContext,
  args: { hsCode: string },
): Promise<{ enrichmentId: string; mfnRatePct: number | null; lineFound: boolean }> {
  const result = await ctx.upstream.usitc.tariff({ hsCode: args.hsCode });
  const enrichmentId = await recordEnrichment(ctx, {
    source: 'usitc',
    subjectKind: 'hs_line',
    subjectKey: args.hsCode,
    requestParams: { hsCode: args.hsCode },
    result,
  });

  const rows = Array.isArray(result.data) ? result.data : [];
  /**
   * **Which line answered is part of what the rate means** (SPEC §7.1).
   *
   * `chooseHtsLine` prefers the line carrying the queried code and otherwise
   * takes the most general line beneath it, in a total order rather than
   * whichever the API happened to return first. Both facts are stored, because
   * the seed's own note on `8708.99` is that the lines under one heading run
   * Free to 2.5% — so *"5% on 8544.30"* and *"5% on 8544.30.00.00, asked as
   * 8544.30"* are different claims and only one of them was being written down.
   */
  const { line, matchedBy } = chooseHtsLine(rows, args.hsCode);
  const mfnRatePct = parseRate(line?.general ?? null);

  await ctx.db.insert(t.tariffLine).values({
    enrichmentId,
    hsCode: args.hsCode,
    importerCountry: 'USA',
    description: line?.description ?? null,
    mfnRate: mfnRatePct?.toFixed(3) ?? null,
    rateText: line?.general ?? null,
    matchedHtsno: line?.htsno ?? null,
    matchedBy,
  });
  /**
   * Whether the search matched an HS line at all, which is a different fact
   * from whether that line carried a parseable general rate — and it is the one
   * the data-confidence checklist needs: a call that matched nothing returned
   * no answer about this Category, however successfully it completed.
   */
  return { enrichmentId, mfnRatePct, lineFound: line != null };
}

/**
 * A date, or null — never an `Invalid Date`.
 *
 * `new Date(x)` returns an Invalid Date rather than throwing, and the failure
 * then surfaces four layers away inside the Postgres driver as
 * `RangeError: Invalid time value`, naming neither the field nor the row. An
 * unparseable published date is a normal thing for a news feed to contain, so
 * it is handled here where the field's name is still in scope.
 */
export function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** "Free" is 0%; "5%" is 5. Anything else is null rather than a guess. */
export function parseRate(text: string | null): number | null {
  if (!text) return null;
  if (/free/i.test(text)) return 0;
  const match = /(\d+(?:\.\d+)?)\s*%/.exec(text);
  return match ? Number(match[1]) : null;
}

// ── 5. Geocoding ─────────────────────────────────────────────────────────────

/**
 * **For Plants and unresolved rows only** (SPEC §7.1).
 *
 * Sayari's own `x`/`y` supersedes this for a resolved Profile, so calling it
 * there would spend a rate-limited request to learn something already known.
 *
 * Appended per generation like the rest; the Program map reads it through
 * `latestGeocodePoints`, which is what stops a re-geocode from putting two
 * coordinates in front of one dot.
 */
export async function enrichGeocode(
  ctx: EnrichContext,
  args: { subjectKey: string; address: string },
): Promise<{ enrichmentId: string; lat: number | null; lon: number | null; precision: string }> {
  const result = await ctx.upstream.nominatim.geocode({ q: args.address });
  const enrichmentId = await recordEnrichment(ctx, {
    source: 'nominatim',
    subjectKind: 'address',
    subjectKey: args.subjectKey,
    requestParams: { address: args.address },
    result,
  });

  const hit = result.data[0];
  const precision = precisionOf(hit?.addresstype ?? hit?.type ?? null);
  await ctx.db.insert(t.geocode).values({
    enrichmentId,
    queryAddress: args.address,
    lat: hit?.lat ? Number(hit.lat) : null,
    lon: hit?.lon ? Number(hit.lon) : null,
    precision,
    displayName: hit?.display_name ?? null,
    provider: 'nominatim',
  });
  return {
    enrichmentId,
    lat: hit?.lat ? Number(hit.lat) : null,
    lon: hit?.lon ? Number(hit.lon) : null,
    precision,
  };
}

/**
 * Every geocode records its precision, because **4 of 6 sampled addresses
 * missed at building precision**. A city centroid is not a factory, and the UI
 * must say which it got rather than imply a surveyed point.
 */
export function precisionOf(
  addressType: string | null,
): (typeof t.geocodePrecision.enumValues)[number] {
  if (!addressType) return 'unknown';
  if (/^(building|house|amenity|industrial|commercial|office)$/i.test(addressType))
    return 'building';
  if (/^(road|street|residential|pedestrian)$/i.test(addressType)) return 'street';
  if (/^(suburb|neighbourhood|quarter|hamlet|village)$/i.test(addressType)) return 'locality';
  if (/^(city|town|municipality)$/i.test(addressType)) return 'city';
  if (/^(state|province|region|county)$/i.test(addressType)) return 'region';
  if (/^country$/i.test(addressType)) return 'country';
  return 'unknown';
}

// ── 6. The Corporate family ──────────────────────────────────────────────────

/**
 * **One call at `limit: 50`, on the standard enrichment path** (SPEC §8).
 *
 * Every path terminal arrives as a full entity with its `risk` block inline, so
 * this never fans out. Truncation is recorded, which is what makes *"17 of
 * 2 275 explored"* the honest phrasing.
 */
export async function enrichFamily(
  ctx: EnrichContext,
  args: { entityId: string },
): Promise<{
  enrichmentId: string;
  members: FamilyMemberRisk[];
  truncated: boolean;
  reachable: number | null;
}> {
  const result = await ctx.upstream.sayari.ownership({
    id: args.entityId,
    limit: FAMILY_TRAVERSAL_LIMIT,
  });
  const enrichmentId = await recordEnrichment(ctx, {
    source: 'sayari_ownership_family',
    subjectKind: 'entity',
    subjectKey: args.entityId,
    requestParams: { entityId: args.entityId, limit: FAMILY_TRAVERSAL_LIMIT },
    result,
  });

  const paths = result.data.data ?? [];
  const byId = new Map<string, GraphPathWrite>();

  for (const path of paths) {
    const entity = terminalEntityOf(path, args.entityId);
    if (!entity || byId.has(entity.id)) continue;
    const edgeIds = await storePathEdges(ctx, path, args.entityId, { source: 'ownership' });
    byId.set(entity.id, {
      entity,
      // The one hop-depth rule (`ownershipHopDepth`), not `path.path?.length`
      // — a `possibly_same_as` step is a move sideways between two records of
      // the same company, not a step down the ownership chain, and counting
      // path length reported a direct subsidiary reached through two psa hops
      // as three hops away (network spec §6, the "one hop-depth rule"
      // disagreement this ticket fixes).
      hopDepth: ownershipHopDepth(path.path),
      edgeIds,
    });
  }

  /**
   * **Coverage is read off the envelope, not inferred from the page.**
   *
   * `partial_results` is the API's own statement that it stopped short of
   * searching the subgraph, and `next` its statement that more paths exist;
   * filling the window is our guess at the same thing, and all three are kept
   * because a walk that filled its window is capped whether or not the envelope
   * says so. This is what makes the badge's *explored to the cap* true rather
   * than assumed — `reachable_count` had been null on every row this app has
   * ever written, so the *n of m* clause had never rendered at all.
   */
  const envelope = result.data;
  const apiPartial = envelope.partial_results === true;
  const truncated = apiPartial || envelope.next === true || paths.length >= FAMILY_TRAVERSAL_LIMIT;

  /**
   * **The same rule the Deep Traversal uses** (`traverse.ts`): `explored_count`
   * is the API's own figure, and only where it says it finished. Where it
   * returned partial results the figure bounds nothing, and *unknown* is the
   * only honest value.
   *
   * It is a count of **nodes the traversal visited**, not of companies in the
   * family — 5,047 against a Yazaki family of seventeen — so the badge names
   * the unit rather than presenting it as a family size
   * (`describeFamilyExposure`).
   */
  const exploredCount = apiPartial ? null : (envelope.explored_count ?? null);

  /**
   * **The row write is shared with the Deep Traversal** (`family-members.ts`).
   *
   * A Deep Traversal that reaches a subsidiary writes into this same
   * `(root, terminal, kind: 'family')` row, distinguished by
   * `discovered_by_job` — so both reads had exactly one thing to say about a
   * member, and only one of them should say it. What stays here is what is
   * particular to the automatic read: one call at `limit: 50`, and its own
   * envelope's account of how far that call got.
   */
  const members = await writeGraphPaths(ctx.db, {
    rootEntityId: args.entityId,
    enrichmentId,
    kind: 'family',
    direction: 'down',
    members: [...byId.values()],
    coverage: { truncated, exploredCount, partialResults: apiPartial },
    discoveredByJob: null,
    // This is `traversal.ownership`, named explicitly rather than left to
    // `writeGraphPaths`'s default — which exists for the one caller this
    // ticket does not own (`traverse.ts`'s Deep Traversal).
    source: 'ownership',
  });

  return { enrichmentId, members, truncated, reachable: exploredCount };
}

// ── 6b. Watchlist ────────────────────────────────────────────────────────────

/**
 * The second automatic call per accepted Profile (network spec §4.1):
 * `traversal.watchlist`, `maxDepth: 4`, `psa: true`, `limit: 50`, the
 * endpoint's own default 31 relationship types spanning ownership, control and
 * trade — unlike the Corporate family read, which narrows to five ownership
 * types. Paths to Listed entities in **either** direction; a terminal carries
 * its `risk` block inline, exactly like an ownership/ubo terminal, so a Listed
 * entity's risk is read off the stored Path without a second call.
 *
 * Mirrors `enrichFamily`'s own shape — one call, one Enrichment, one page —
 * rather than inventing a different one: a person or a future filter can widen
 * this later (on-demand watchlist reads are not this ticket's job), but the
 * automatic read stays exactly as narrow as the automatic family read.
 */
export async function enrichWatchlist(
  ctx: EnrichContext,
  args: { entityId: string },
): Promise<{
  enrichmentId: string;
  members: FamilyMemberRisk[];
  truncated: boolean;
  reachable: number | null;
}> {
  const result = await ctx.upstream.sayari.watchlist({
    id: args.entityId,
    maxDepth: WATCHLIST_TRAVERSAL_MAX_DEPTH,
    psa: true,
    limit: WATCHLIST_TRAVERSAL_LIMIT,
  });
  const enrichmentId = await recordEnrichment(ctx, {
    source: 'sayari_watchlist',
    subjectKind: 'entity',
    subjectKey: args.entityId,
    requestParams: {
      entityId: args.entityId,
      maxDepth: WATCHLIST_TRAVERSAL_MAX_DEPTH,
      psa: true,
      limit: WATCHLIST_TRAVERSAL_LIMIT,
    },
    result,
  });

  const paths = result.data.data ?? [];
  const byId = new Map<string, GraphPathWrite>();

  for (const path of paths) {
    const entity = terminalEntityOf(path, args.entityId);
    if (!entity || byId.has(entity.id)) continue;
    const edgeIds = await storePathEdges(ctx, path, args.entityId, { source: 'watchlist' });
    byId.set(entity.id, {
      entity,
      hopDepth: ownershipHopDepth(path.path),
      edgeIds,
    });
  }

  const envelope = result.data;
  const apiPartial = envelope.partial_results === true;
  const truncated =
    apiPartial || envelope.next === true || paths.length >= WATCHLIST_TRAVERSAL_LIMIT;
  const exploredCount = apiPartial ? null : (envelope.explored_count ?? null);

  /**
   * `direction: 'either'` — the endpoint's own design follows any relationship
   * type outward without a fixed direction (network spec §6), unlike
   * `family`'s always-`down`.
   */
  const members = await writeGraphPaths(ctx.db, {
    rootEntityId: args.entityId,
    enrichmentId,
    kind: 'watchlist',
    direction: 'either',
    members: [...byId.values()],
    coverage: { truncated, exploredCount, partialResults: apiPartial },
    discoveredByJob: null,
    source: 'watchlist',
  });

  return { enrichmentId, members, truncated, reachable: exploredCount };
}

// ── 6c. Filtered ownership exposure ──────────────────────────────────────────

/**
 * The third automatic call per accepted Profile (network spec §4.1):
 * `traversal.ownership` again — same endpoint and direction as `enrichFamily`
 * — with `riskCategories: [sanctions, export_controls, forced_labor]` and
 * `excludeClosedEntities: true`, so the server itself returns the owned
 * entities that carry exposure **wherever they sit in the explored set**, not
 * the first fifty in server order the unfiltered page happens to return.
 *
 * **Writes into the same `graph_path` rows as `enrichFamily`, not a second
 * set.** Both are `kind: 'family'`, `direction: 'down'` — the unique key on
 * `graph_path` is `(root, terminal, kind)`, so a terminal this filtered page
 * reaches that the unfiltered page already wrote upserts into that row and
 * only sets `filtered: true` on it (sticky, per `writeGraphPaths`'s own
 * conflict handling); a terminal only the filtered page reaches — the risk
 * case the unfiltered page's first-fifty-in-server-order window could have
 * missed — inserts a new row, `filtered: true` from the start. Network spec
 * §4.1: *"the existing unfiltered family page stays as the first page of kind
 * family; the filtered page is a second page of the same kind with
 * `filtered: true` on its Paths"* — a second PAGE, not a second kind.
 *
 * **Its own `enrichment_source`, `sayari_ownership_exposure`, distinct from
 * `sayari_ownership_family`** (see that enum's doc comment, `src/db/schema/
 * enums.ts`): the request genuinely differs (`riskCategories`,
 * `excludeClosedEntities` change what comes back, same as the reasoning that
 * splits `sayari_owner_edges` off a shared endpoint), and — decisively —
 * `fanOutEnrichments` calls this back to back with `enrichFamily` for the same
 * Profile, so sharing a source would make `recordEnrichment`'s counted
 * generation alternate family/filtered on every enrich pass rather than
 * counting *how many times we asked this question*, and would make a *latest
 * generation of `sayari_ownership_family`* read always resolve to this
 * filtered call instead.
 */
export async function enrichOwnership(
  ctx: EnrichContext,
  args: { entityId: string },
): Promise<{
  enrichmentId: string;
  members: FamilyMemberRisk[];
  truncated: boolean;
  reachable: number | null;
}> {
  const riskCategories = [...OWNERSHIP_EXPOSURE_RISK_CATEGORIES];
  const result = await ctx.upstream.sayari.ownership({
    id: args.entityId,
    riskCategories,
    excludeClosedEntities: true,
    limit: OWNERSHIP_EXPOSURE_TRAVERSAL_LIMIT,
  });
  const enrichmentId = await recordEnrichment(ctx, {
    source: 'sayari_ownership_exposure',
    subjectKind: 'entity',
    subjectKey: args.entityId,
    requestParams: {
      entityId: args.entityId,
      riskCategories,
      excludeClosedEntities: true,
      limit: OWNERSHIP_EXPOSURE_TRAVERSAL_LIMIT,
    },
    result,
  });

  const paths = result.data.data ?? [];
  const byId = new Map<string, GraphPathWrite>();

  for (const path of paths) {
    const entity = terminalEntityOf(path, args.entityId);
    if (!entity || byId.has(entity.id)) continue;
    const edgeIds = await storePathEdges(ctx, path, args.entityId, { source: 'ownership' });
    byId.set(entity.id, {
      entity,
      hopDepth: ownershipHopDepth(path.path),
      edgeIds,
    });
  }

  const envelope = result.data;
  const apiPartial = envelope.partial_results === true;
  const truncated =
    apiPartial || envelope.next === true || paths.length >= OWNERSHIP_EXPOSURE_TRAVERSAL_LIMIT;
  const exploredCount = apiPartial ? null : (envelope.explored_count ?? null);

  const members = await writeGraphPaths(ctx.db, {
    rootEntityId: args.entityId,
    enrichmentId,
    kind: 'family',
    direction: 'down',
    members: [...byId.values()],
    coverage: { truncated, exploredCount, partialResults: apiPartial },
    discoveredByJob: null,
    filtered: true,
    source: 'ownership',
  });

  return { enrichmentId, members, truncated, reachable: exploredCount };
}

/**
 * Writes every resolvable hop of an already-summarised Path as a citable
 * `entity_relationship` edge, and returns their ids in hop order —
 * `graph_path.edge_ids` (network spec §6).
 *
 * Takes `summarisePath`'s own output rather than a raw path, so a caller that
 * has already summarised a path for its own purposes — `traverse.ts`'s
 * `mergeMembers`, which stays synchronous and database-free by design — does
 * not summarise it twice. `storePathEdges` below is the convenience form for a
 * caller (`enrichFamily`, `enrichWatchlist`) that has not.
 *
 * Drops the hops `summarisePath` could not resolve to an edge and calls
 * `storeRelationships` once for the rest, so a Path's edges are written in the
 * same order they are cited in and every entity along the chain is upserted
 * before the next hop's edge can reference it as its `from`.
 */
export async function storeHopEdges(
  ctx: EnrichContext,
  hops: readonly PathHop[],
  options: { source: EntitySource },
): Promise<string[]> {
  const resolvable = hops.filter((hop) => hop.edge != null);
  if (resolvable.length === 0) return [];

  const { ids } = await storeRelationships(
    ctx.db,
    resolvable.map((hop) => hop.edge!),
    ctx.jobId,
    { hopDepth: resolvable.map((hop) => hop.hopDepth), source: options.source },
  );
  return ids.filter((id): id is string => id != null);
}

/** `storeHopEdges`, summarising a raw path first — the shape `enrichFamily`/`enrichWatchlist` hold. */
async function storePathEdges(
  ctx: EnrichContext,
  path: SayariTraversalPath,
  rootEntityId: string,
  options: { source: EntitySource },
): Promise<string[]> {
  return storeHopEdges(ctx, summarisePath(path.path, rootEntityId), options);
}

// ── Owner edges ──────────────────────────────────────────────────────────────

/** One owner edge, as scoring and the Entity page see it (items B, C). */
export type OwnerEdge = {
  entityId: string;
  label: string;
  riskFactors: ReturnType<typeof parseRiskObject>;
  isStateOwned: boolean;
  /** From `attributes.shares[].percentage`, when the occurrence carries one. */
  sharePercentage: number | null;
  startDate: string | null;
  endDate: string | null;
};

/**
 * Current one-hop owner edges, for the Ownership exposure Criterion.
 *
 * Where `relationshipCount` says owner edges exist but the entity payload's
 * window was swamped by trade edges, this reads them with a **type-filtered
 * traversal at `maxDepth: 1`** rather than paging the entity payload — which is
 * cheaper and answers the question directly (SPEC §16.6).
 *
 * **`relationshipsTruncated` alone is not the test.** That flag fires on any
 * truncated window — trade edges alone can do it — so it says nothing about
 * whether an *owner* edge was actually lost. The real test is per type: does
 * `relationship_count` claim more edges of an upward-ownership type than
 * `parseRelationships` actually found in the window that came back.
 *
 * **`gapCoverage` names whether the gap-fill traversal is trustworthy, not
 * just whether it ran.** `'complete'` covers both "there was no gap to fill"
 * and "there was, and the traversal answered it"; `'unknown'` is the one
 * remaining case, where a gap was detected and the traversal that would have
 * filled it failed (a Sayari 5xx or timeout that survived `call()`'s own
 * retries, most likely). The window's own edges are almost never empty even
 * then — a company usually has at least one owner edge in its payload
 * already — so an empty check on the returned `owners` array cannot tell a
 * complete read from an incomplete one here. The caller has to be told
 * separately, which is what this field is for.
 */
export async function readOwnerEdges(
  ctx: EnrichContext,
  args: { entityId: string; entity: SayariEntity },
): Promise<{ owners: OwnerEdge[]; gapCoverage: 'complete' | 'unknown' }> {
  const { edges, unclassified } = parseRelationships(args.entity, args.entityId);

  if (unclassified.length > 0) {
    /**
     * Loud, and not fatal. A relationship type nobody has classified is stored
     * and shown like any other; what it may not do is reach Ownership exposure,
     * because the safe reading of an edge we cannot orient is *not an owner*.
     * Failing the Job instead would let Sayari's vocabulary growth stop an
     * enrichment that is otherwise complete.
     */
    console.warn(
      `  unclassified relationship type(s) on ${args.entityId}: ${unclassified.join(', ')}` +
        ' — stored, shown, and excluded from ownership scoring',
    );
  }

  // These came out of the entity's own payload, so `getEntity` names the
  // source and `1` the hop depth — both the defaults, named explicitly.
  await storeRelationships(ctx.db, edges, ctx.jobId, { hopDepth: 1, source: 'getEntity' });

  let ownerEdges = edges;
  let gapCoverage: 'complete' | 'unknown' = 'complete';
  const missingTypes = ownerEdgeGap(args.entity, edges);
  if (missingTypes.length > 0) {
    try {
      const typed = await ctx.upstream.sayari.traversal({
        id: args.entityId,
        maxDepth: 1,
        relationships: missingTypes,
      });
      await recordEnrichment(ctx, {
        source: 'sayari_owner_edges',
        subjectKind: 'entity',
        subjectKey: args.entityId,
        requestParams: { entityId: args.entityId, maxDepth: 1, relationships: missingTypes },
        result: typed,
      });

      const typedEdges = parseTypedOwnerEdges(typed.data, args.entityId);

      /**
       * **Skip a typed edge the window already stored, by (from, to, type)**
       * (P3). `ownerEdgeGap` fires per relationship TYPE, not per target —
       * a window short one `has_shareholder` edge asks the traversal for
       * every `has_shareholder` edge it can find, which legitimately
       * re-returns owners the window already named alongside the one it was
       * missing. Storing those re-echoes anyway is what duplicated a
       * "Current owner" row before this fix, even with `record` now carried
       * (some traversal paths still answer with none of their own).
       */
      const windowKeys = new Set(
        edges.map((e) => `${e.subjectId}:${e.targetId}:${e.relationshipType}`),
      );
      const newTypedEdges = typedEdges.filter(
        (e) => !windowKeys.has(`${e.subjectId}:${e.targetId}:${e.relationshipType}`),
      );
      await storeRelationships(ctx.db, newTypedEdges, ctx.jobId, {
        hopDepth: 1,
        source: 'traversal',
      });

      // Additive, not a replacement: the window's own edges are kept, and the
      // typed read only fills in owner-type edges the window missed. A target
      // both already named is not counted twice.
      const seen = new Set(ownersOf(edges).map((e) => `${e.relationshipType}:${e.targetId}`));
      for (const edge of ownersOf(newTypedEdges)) {
        const key = `${edge.relationshipType}:${edge.targetId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        ownerEdges = [...ownerEdges, edge];
      }
    } catch (error) {
      // Loud, and not fatal — the same rule as an unclassified type. Ownership
      // still reads whatever the window itself carried; it is only the gap
      // that goes unfilled. `gapCoverage` records that the gap is unfilled,
      // not merely unfillable this run, so the scoring side can tell "this
      // Profile genuinely has no more owner edges" from "we don't actually
      // know" — the same distinction `console.warn` already draws for a human
      // reader, now also carried to the one caller that decides an Ownership
      // exposure score.
      gapCoverage = 'unknown';
      console.warn(
        `  typed owner-edge read failed for ${args.entityId}, falling back to the window's ` +
          `edges: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const owners: OwnerEdge[] = [];
  for (const edge of ownersOf(ownerEdges)) {
    const target = edge.targetEntity as SayariEntity | null;
    const factors = parseRiskObject(target?.risk);
    owners.push({
      entityId: edge.targetId,
      label: edge.targetLabel ?? edge.targetId,
      riskFactors: factors,
      isStateOwned: factors.some((f) => /soe|state_owned|government/i.test(f.name)),
      sharePercentage: sharePercentageOf(edge.attributes),
      startDate: edge.startDate,
      endDate: edge.endDate,
    });
  }
  return { owners, gapCoverage };
}

/**
 * Which of the three upward-ownership types `relationship_count` claims more
 * edges of than the window actually delivered.
 *
 * `relationship_count` is keyed by relation type (SPEC §16.6), so the
 * comparison is per type rather than a single before/after count — a window
 * that is complete for `has_shareholder` but short two `subsidiary_of` edges
 * should ask a traversal for `subsidiary_of` alone, not repeat the whole read.
 */
export function ownerEdgeGap(entity: SayariEntity, edges: readonly ParsedEdge[]): string[] {
  const counts = (entity.relationship_count ?? {}) as Record<string, unknown>;
  const seenByType = new Map<string, number>();
  for (const edge of ownersOf(edges)) {
    seenByType.set(edge.relationshipType, (seenByType.get(edge.relationshipType) ?? 0) + 1);
  }
  return upwardOwnershipTypes().filter((type) => {
    const claimed = counts[type];
    return typeof claimed === 'number' && claimed > (seenByType.get(type) ?? 0);
  });
}

/** One occurrence of a typed traversal path's own `relationships[type].values[]` entry. */
type TypedRelationshipValue = {
  record?: string | null;
  from_date?: string | null;
  to_date?: string | null;
  former?: boolean | null;
  attributes?: unknown;
};

/**
 * Turns a type-filtered `traversal.traversal` response into edges shaped like
 * `parseRelationships`'s, so the typed read can share `storeRelationships` and
 * `ownersOf` with the window read rather than needing its own copy of either.
 *
 * A traversal path names the relationship from the root's own side — the same
 * convention `parseRelationships`'s header documents for the entity payload —
 * so a one-hop path's `field` is exactly what `relationshipType` would have
 * been had the window included this edge.
 *
 * **Occurrence-level detail comes off the same step's own `relationships`
 * group** (P3, PR #19 review): one row per `values[]` entry, exactly the
 * "one row per occurrence" rule `parseRelationships` applies to the entity
 * payload. This is not optional — `record` is what lets `storeRelationships`'
 * unique key `(from, to, type, source_record_id)` recognise a re-sighting of
 * an edge the window already stored as the SAME row rather than a new one:
 * Postgres does not treat two NULLs as equal for that constraint, so leaving
 * `sourceRecordId` null duplicated every typed-read owner.
 */
export function parseTypedOwnerEdges(
  traversal: { data?: unknown },
  rootEntityId: string,
): ParsedEdge[] {
  const paths = Array.isArray(traversal.data) ? (traversal.data as SayariTraversalPath[]) : [];
  const edges: ParsedEdge[] = [];
  for (const path of paths) {
    const target = terminalEntityOf(path, rootEntityId);
    if (!target) continue;
    const step = path.path?.[0];
    const relationshipType = step?.field;
    if (typeof relationshipType !== 'string') continue;

    const bag = step?.relationships;
    const group =
      bag && typeof bag === 'object' && !Array.isArray(bag)
        ? (bag as Record<string, { values?: readonly TypedRelationshipValue[] | null } | null>)[
            relationshipType
          ]
        : undefined;
    const values = group?.values && group.values.length > 0 ? group.values : [undefined];

    for (const value of values) {
      edges.push({
        subjectId: rootEntityId,
        targetId: target.id,
        targetLabel: target.label ?? null,
        targetType: target.type ?? null,
        relationshipType,
        former: value?.former === true,
        startDate: value?.from_date ?? null,
        endDate: value?.to_date ?? null,
        sourceRecordId: value?.record ?? null,
        attributes:
          value?.attributes && typeof value.attributes === 'object'
            ? (value.attributes as Record<string, unknown>)
            : null,
        targetEntity: target as unknown as Record<string, unknown>,
      });
    }
  }
  return edges;
}

/**
 * Writes edges, and the companies on the far end of them — returning the
 * resulting `entity_relationship.id` for each, in the same order as `edges`
 * (network spec §6: `graph_path.edge_ids` is built by zipping these against
 * the hops that produced them and dropping the skipped ones).
 *
 * **The entity rows come first, and that is a foreign key, not a preference:**
 * `entity_relationship` references `entity` on both ends, so an edge to a
 * company nobody has stored is rejected by the database. A target that arrived
 * as a bare id therefore has no row to write — it is skipped (its slot in
 * `ids` is `null`) rather than invented, which is the same rule the rest of
 * this app follows about evidence it does not hold.
 *
 * **`hopDepth` is the minimum on conflict, never the newest** — the schema
 * comment on `entity_relationship.hop_depth` has said so since before this
 * function implemented it. An edge first seen at depth 3 by a Deep Traversal
 * and later at depth 1 by an ownership read is a 1-hop edge; the pattern is
 * `conflictSet` in `family-members.ts`, applied here to one column instead of
 * three because an edge carries no coverage figures of its own to overwrite.
 *
 * `hopDepth` may be one number for the whole batch (every caller before this
 * ticket: one entity payload window, one hop) or one number **per edge**,
 * positionally against `edges` — what a multi-hop Path needs, since each of
 * its hops sits at a different depth from the root (`storePathEdges`,
 * `traverse.ts`'s Deep Traversal). Defaults to depth 1 where neither is given.
 */
export async function storeRelationships(
  db: Database,
  edges: readonly ParsedEdge[],
  jobId?: string | undefined,
  options?: { hopDepth?: number | readonly number[]; source?: EntitySource },
): Promise<{ written: number; ids: (string | null)[] }> {
  const source = options?.source ?? 'getEntity';
  const hopDepthAt = (index: number): number => {
    const configured = options?.hopDepth;
    return Array.isArray(configured) ? (configured[index] ?? 1) : ((configured as number) ?? 1);
  };
  const ids: (string | null)[] = [];
  let written = 0;

  for (let index = 0; index < edges.length; index += 1) {
    const edge = edges[index]!;
    if (!edge.targetEntity) {
      ids.push(null);
      continue;
    }
    await upsertEntity(db, edge.targetEntity as unknown as SayariEntity, undefined, source);

    const [row] = await db
      .insert(t.entityRelationship)
      .values({
        // Stored as the payload states it: subject first, target second, type
        // verbatim. Direction is resolved on read, so nothing inverts on write.
        fromEntityId: edge.subjectId,
        toEntityId: edge.targetId,
        relationshipType: edge.relationshipType,
        former: edge.former,
        startDate: edge.startDate,
        endDate: edge.endDate,
        sourceRecordId: edge.sourceRecordId,
        hopDepth: hopDepthAt(index),
        discoveredByJob: jobId ?? null,
        attributes: edge.attributes as never,
      })
      .onConflictDoUpdate({
        // The unique key is (from, to, type, source_record_id); seeing the
        // same edge twice is the normal case on a warm cache, and the only
        // thing a repeat sighting may change is how close it says the edge is.
        target: [
          t.entityRelationship.fromEntityId,
          t.entityRelationship.toEntityId,
          t.entityRelationship.relationshipType,
          t.entityRelationship.sourceRecordId,
        ],
        set: { hopDepth: sql`least(${t.entityRelationship.hopDepth}, excluded.hop_depth)` },
      })
      .returning({ id: t.entityRelationship.id });
    ids.push(row?.id ?? null);
    written += 1;
  }

  return { written, ids };
}

/** The Plants a Supplier's proximity is measured against. */
export async function loadPlants(db: Database, programId: string): Promise<PlantPoint[]> {
  const rows = await db.select().from(t.plant).where(eq(t.plant.programId, programId));
  return rows.map((p) => ({ code: p.code, city: p.city, lat: p.lat, lon: p.lon }));
}

export { nearestPlant };

/**
 * Writes a Criterion value **append-only**, superseding the previous current
 * row rather than updating it (SPEC §3.5).
 *
 * Append-only because a published Assessment cites a `criterion_value` row: if
 * a re-enrich could overwrite it in place, a cited number would change
 * underneath the sentence that argued from it.
 */
export async function writeCriterionValue(
  db: Database,
  args: {
    supplierId: string;
    programId: string;
    categoryId: string | null;
    criterionKey: string;
    value: number | null;
    unknownReason: string | null;
    rawInputs: Record<string, unknown>;
    anchorLine: string;
    jobId?: string | undefined;
  },
): Promise<string> {
  const previous = await db.query.criterionValue.findFirst({
    where: and(
      eq(t.criterionValue.supplierId, args.supplierId),
      eq(t.criterionValue.programId, args.programId),
      eq(t.criterionValue.criterionKey, args.criterionKey),
      eq(t.criterionValue.isCurrent, true),
      args.categoryId
        ? eq(t.criterionValue.categoryId, args.categoryId)
        : eq(t.criterionValue.criterionKey, args.criterionKey),
    ),
  });

  const [{ generation }] = (await db
    .select({ generation: sql<number>`count(*)::int` })
    .from(t.criterionValue)
    .where(
      and(
        eq(t.criterionValue.supplierId, args.supplierId),
        eq(t.criterionValue.criterionKey, args.criterionKey),
      ),
    )) as [{ generation: number }];

  const [row] = await db
    .insert(t.criterionValue)
    .values({
      id: derivedId('criterion_value', `${args.supplierId}:${args.criterionKey}`, generation),
      supplierId: args.supplierId,
      programId: args.programId,
      categoryId: args.categoryId,
      criterionKey: args.criterionKey,
      value: args.value,
      unknownReason: args.unknownReason,
      rawInputs: args.rawInputs as never,
      anchorLine: args.anchorLine,
      supersedesId: previous?.id ?? null,
      isCurrent: true,
      jobId: args.jobId ?? null,
    })
    .returning({ id: t.criterionValue.id });

  if (previous) {
    await db
      .update(t.criterionValue)
      .set({ isCurrent: false })
      .where(eq(t.criterionValue.id, previous.id));
  }
  return row!.id;
}

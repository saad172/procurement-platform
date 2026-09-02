import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as t from '@/db/schema';
import { latestCountryIndicators, latestNewsItems } from '@/db/queries/enrichments';
import { computeFamilyExposure, unionRiskFactors } from '@/domain/family';
import { nearestPlant } from '@/domain/geo';
import type { CountrySource } from '@/domain/match/settle-match';
import { scoreSupplier } from '@/domain/score';
import { parseRiskObject } from '@/domain/scoring/risk-factors';
import type { SupplierScoringInput } from '@/domain/scoring/types';
import {
  enrichCountry,
  enrichFamily,
  enrichGeocode,
  enrichLei,
  enrichNegativeNews,
  enrichTariff,
  loadPlants,
  readOwnerEdges,
  writeCriterionValue,
  type EnrichContext,
} from './enrich';

/**
 * The enrich Job for one Supplier (SPEC §7, §8, §9).
 *
 * Fetches what is missing, then recomputes every Criterion value through the
 * same pure `score.ts` the browser calls — so a value written here and a value
 * computed during a weight drag cannot disagree.
 *
 * **A Supplier with no accepted Match is enriched no further than its country.**
 * There is no Profile to fetch news or ownership for, and the Criteria all
 * return `unknown` anyway (SPEC §13.3).
 */

export type EnrichResult = {
  supplierId: string;
  enrichmentsWritten: string[];
  criterionValuesWritten: number;
  familyMembers: number;
  skipped: string | undefined;
};

export async function enrichSupplier(
  ctx: EnrichContext,
  args: { supplierId: string; programId: string },
): Promise<EnrichResult> {
  const { db } = ctx;

  const loaded = await loadResolvedProfile(db, ctx, args);
  if (loaded.result) return loaded.result;
  const { profile } = loaded;

  const fanOut = await fanOutEnrichments(ctx, profile);
  const { owners } = await loadOwnershipEvidence(ctx, profile.match);
  const baseInput = await assembleScoringInput(ctx, args, profile, fanOut, owners);

  const criterionValuesWritten = await writeAllCriteria(db, {
    supplier: profile.supplier,
    programId: args.programId,
    categoryIds: profile.categories.map((c) => c.categoryId),
    input: baseInput,
    tariffByCategory: fanOut.tariffByCategory,
    jobId: ctx.jobId,
  });

  return finalizeEnrichResult(profile.supplier, fanOut, criterionValuesWritten);
}

/** A `match` row narrowed to the `accepted` case: `entityId` is never null. */
type AcceptedMatch = Omit<typeof t.match.$inferSelect, 'entityId'> & { entityId: string };

type ResolvedProfile = {
  supplier: typeof t.supplier.$inferSelect;
  match: AcceptedMatch;
  categories: { categoryId: string }[];
  profileRow: typeof t.entity.$inferSelect;
  /**
   * The country everything country-derived is fetched and scored against
   * (SPEC §9.4) — the one the Match settled on. See `siteCountryOf`.
   */
  siteCountry: string | undefined;
  countrySource: CountrySource;
};

/**
 * Loads the Supplier, its Match and its Categories, and settles the no-Profile
 * case on the spot.
 *
 * **A Supplier with no accepted Match is enriched no further than its
 * country.** There is no Profile to fetch news or ownership for, and the
 * Criteria all return `unknown` anyway (SPEC §13.3).
 */
async function loadResolvedProfile(
  db: Database,
  ctx: EnrichContext,
  args: { supplierId: string; programId: string },
): Promise<{ result: EnrichResult } | { result: null; profile: ResolvedProfile }> {
  const supplier = await db.query.supplier.findFirst({ where: eq(t.supplier.id, args.supplierId) });
  if (!supplier) throw new Error(`no supplier ${args.supplierId}`);

  const match = await db.query.match.findFirst({ where: eq(t.match.supplierId, supplier.id) });
  const categories = await db
    .select({ categoryId: t.supplierCategory.categoryId })
    .from(t.supplierCategory)
    .where(eq(t.supplierCategory.supplierId, supplier.id));

  // ── No Profile: nothing to enrich, and the Criteria will say why ──────────
  if (!match || match.status !== 'accepted' || !match.entityId) {
    const values = await writeAllCriteria(db, {
      supplier,
      programId: args.programId,
      categoryIds: categories.map((c) => c.categoryId),
      input: unresolvedInput(supplier),
      jobId: ctx.jobId,
    });
    return {
      result: {
        supplierId: supplier.id,
        enrichmentsWritten: [],
        criterionValuesWritten: values,
        familyMembers: 0,
        skipped: `match is ${match?.status ?? 'absent'}, so there is no profile to enrich`,
      },
    };
  }

  const profileRow = await db.query.entity.findFirst({ where: eq(t.entity.id, match.entityId) });
  if (!profileRow) throw new Error(`profile entity ${match.entityId} is not stored`);

  const acceptedMatch = { ...match, entityId: match.entityId };
  const { siteCountry, countrySource } = siteCountryOf(acceptedMatch, profileRow);

  return {
    result: null,
    profile: { supplier, match: acceptedMatch, categories, profileRow, siteCountry, countrySource },
  };
}

/**
 * **The country this Supplier is scored on**, read off the Match (SPEC §9.4).
 *
 * The Match decided it at settle time and wrote it down
 * (`deriveSettledCountry`, `src/domain/match/settle-match.ts`): GLEIF's
 * legal-address country where the settled Candidate has an LEI, else the
 * country of the address the Discriminators anchored on, else the Profile's
 * own.
 *
 * This function used to *derive* it here, from the persisted `country`
 * Discriminator verdicts, and score the roster's country whenever that verdict
 * read `pass`. Two things were wrong with that. It scored what the roster
 * **claimed** rather than what any source **witnessed** — the roster is the
 * question, not an answer. And it made the scored country a function of rows
 * that get re-recorded: re-running a Match moved the country of an already
 * enriched Supplier without anything having said so.
 *
 * The fallback stays: a Match settled before this column existed, a promoted
 * Lead, or a settlement with no evidence, all read the Profile's own country
 * and say `'profile'` — which is the honest source for all three.
 */
export function siteCountryOf(
  match: AcceptedMatch,
  profileRow: typeof t.entity.$inferSelect,
): { siteCountry: string | undefined; countrySource: CountrySource } {
  if (match.settledCountry && match.settledCountrySource) {
    return { siteCountry: match.settledCountry, countrySource: match.settledCountrySource };
  }
  return { siteCountry: profileRow.country ?? undefined, countrySource: 'profile' };
}

type FanOutResult = {
  written: string[];
  family: Awaited<ReturnType<typeof enrichFamily>>;
  tariffByCategory: Map<string, { hsCode: string; mfnRatePct: number | null }>;
  lat: number | null;
  lon: number | null;
  coordinatePrecision: string | undefined;
};

/** Fetches what is missing: news, the Corporate family, country, GLEIF, tariffs, geocoding. */
async function fanOutEnrichments(
  ctx: EnrichContext,
  profile: ResolvedProfile,
): Promise<FanOutResult> {
  const { db } = ctx;
  const { match, profileRow, supplier, categories, siteCountry } = profile;
  const written: string[] = [];

  // ── 1. Negative news, on the RESOLVED LEGAL NAME ─────────────────────────
  const news = await enrichNegativeNews(ctx, {
    entityId: match.entityId,
    resolvedLegalName: profileRow.label,
  });
  written.push(news.enrichmentId);

  // ── 2. The Corporate family — one call, on the standard path ─────────────
  const family = await enrichFamily(ctx, { entityId: match.entityId });
  written.push(family.enrichmentId);

  // ── 3. Country indicators, shared across every Supplier in the country ───
  // Fetched for the country the Match settled on (SPEC §9.4), so the World Bank
  // rows a Supplier holds and the country its Criteria score are the same one.
  if (siteCountry) {
    const country = await enrichCountry(ctx, { country: siteCountry });
    written.push(...country.enrichmentIds);
  }

  // ── 4. GLEIF, where there is an LEI to join on ───────────────────────────
  if (profileRow.lei) {
    const lei = await enrichLei(ctx, { entityId: match.entityId, lei: profileRow.lei });
    if (lei) written.push(lei.enrichmentId);
  }

  // ── 5. Tariffs, per Category's default HS line ───────────────────────────
  const tariffByCategory = new Map<string, { hsCode: string; mfnRatePct: number | null }>();
  for (const { categoryId } of categories) {
    const line = await db.query.categoryHsLine.findFirst({
      where: and(eq(t.categoryHsLine.categoryId, categoryId), eq(t.categoryHsLine.isDefault, true)),
    });
    if (!line) continue;
    const tariff = await enrichTariff(ctx, { hsCode: line.hsCode });
    written.push(tariff.enrichmentId);
    tariffByCategory.set(categoryId, { hsCode: line.hsCode, mfnRatePct: tariff.mfnRatePct });
  }

  // ── 6. Geocoding — ONLY where Sayari has no coordinate of its own ────────
  let lat = profileRow.lat;
  let lon = profileRow.lon;
  let coordinatePrecision = lat != null ? 'building' : undefined;
  if (lat == null && supplier.rosterAddress) {
    const geocode = await enrichGeocode(ctx, {
      subjectKey: supplier.id,
      address: supplier.rosterAddress,
    });
    written.push(geocode.enrichmentId);
    lat = geocode.lat;
    lon = geocode.lon;
    coordinatePrecision = geocode.precision;
  }

  return { written, family, tariffByCategory, lat, lon, coordinatePrecision };
}

/**
 * **The matched entity's OWN payload, asked for by id.**
 *
 * This used to read `upstream_response` directly, for any row whose endpoint
 * was `entity.getEntity` — no filter on *which* entity, and no order. The
 * resolve Job caches one body per candidate it considered, so a Supplier with
 * seven candidates leaves seven rows carrying an identical `fetched_at`
 * (`seedUpstream` writes them in one statement), and Postgres returned
 * whichever it reached.
 *
 * The body then went to `readOwnerEdges` as `entity` while `entityId` stayed
 * the *matched* one, so `parseRelationships` attributed **another company's
 * relationship set to this company** and `storeRelationships` wrote those
 * edges. Measured on the Yazaki fixture: `YAZAKI INDIA PRIVATE LIMITED`'s
 * relationships were stored as the Japanese parent's, including a company the
 * parent's own payload does not mention.
 *
 * It also made the assess replay non-deterministic, because the entity rows
 * those edges upsert are what `get_entity` hands the model — finding 100, and
 * the third time in this build that a query with no total order was read as
 * prompt drift (findings 61 and 81).
 *
 * Going through `ctx.upstream` rather than fixing the `where` clause keeps
 * one reader of the cache. `call()` is cache-first, so this costs nothing on
 * a warm cache and nothing at all in replay, where the fixture already holds
 * the row.
 */
async function loadOwnershipEvidence(
  ctx: EnrichContext,
  match: AcceptedMatch,
): Promise<{ owners: Awaited<ReturnType<typeof readOwnerEdges>> }> {
  const own = await ctx.upstream.sayari
    .getEntity({ id: match.entityId })
    .catch((error: unknown) => {
      /**
       * Loud, and not fatal — the same rule as the unclassified relationship
       * types above. Ownership will read `unknown`, and §10's reason has to be
       * able to say *why*: "we could not read the payload" and "this company has
       * no owners" are the distinction the Criterion exists to preserve, and a
       * silent `[]` collapses them.
       */
      console.warn(
        `  no own payload for ${match.entityId} — ownership will read unknown: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    });
  const owners = own
    ? await readOwnerEdges(ctx, { entityId: match.entityId, entity: own.data }).catch(
        (error: unknown) => {
          console.warn(
            `  owner edges unreadable for ${match.entityId} — ownership will read unknown: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
          return [];
        },
      )
    : [];
  return { owners };
}

/** ── Assemble the scoring input ─────────────────────────────────────────── */
async function assembleScoringInput(
  ctx: EnrichContext,
  args: { programId: string },
  profile: ResolvedProfile,
  fanOut: FanOutResult,
  owners: Awaited<ReturnType<typeof readOwnerEdges>>,
): Promise<SupplierScoringInput> {
  const { db } = ctx;
  const { supplier, match, profileRow, siteCountry, countrySource } = profile;
  const { lat, lon, coordinatePrecision, tariffByCategory } = fanOut;

  const plants = await loadPlants(db, args.programId);
  const nearest = nearestPlant(lat != null && lon != null ? { lat, lon } : undefined, plants);

  /**
   * **The latest generation of each, and no earlier one** — for the settled
   * country, which is the same one `fanOutEnrichments` fetched, so a fetch and
   * its read never disagree.
   *
   * Both used to be read straight off the value table for the whole subject —
   * every generation at once, and for the indicators with no `ORDER BY` at
   * all — so a second Enrichment doubled the article count behind the media
   * signal Criterion and left the country's value and year to Postgres row
   * order. `db/queries/enrichments.ts` holds the rule and the argument; what
   * matters here is that re-enriching a Supplier may not move a Criterion
   * when the upstream body has not moved (SPEC §9.1).
   */
  const indicators = siteCountry ? await latestCountryIndicators(db, siteCountry) : [];

  const newsRows = await latestNewsItems(db, match.entityId);

  const presentEnrichments = [
    'sayari_negative_news',
    'sayari_ownership_family',
    ...(siteCountry ? ['world_bank'] : []),
    ...(profileRow.lei ? ['gleif'] : []),
    ...(tariffByCategory.size > 0 ? ['usitc'] : []),
    ...(coordinatePrecision ? ['nominatim'] : []),
  ];

  return {
    supplierId: supplier.id,
    displayName: supplier.rosterName ?? profileRow.label,
    match: { status: 'accepted', entityId: match.entityId },
    profile: {
      entityId: match.entityId,
      legalName: profileRow.label,
      // The country the Match settled on — see `siteCountryOf`. `profileCountry`
      // and `countrySource` ride along so a Criterion can show both.
      country: siteCountry,
      profileCountry: profileRow.country ?? undefined,
      countrySource,
      lat: lat ?? undefined,
      lon: lon ?? undefined,
      coordinatePrecision,
      distinctSourceCount: profileRow.distinctSourceCount ?? undefined,
      sanctioned: profileRow.sanctioned,
      pep: profileRow.pep,
      closed: profileRow.closed,
      // Unioned with per-factor provenance across the endpoints that reported.
      riskFactors: unionRiskFactors([{ source: 'getEntity', risk: profileRow.risk }]).map(
        (u) => u.factor,
      ),
      psaCount: profileRow.psaCount ?? undefined,
      relationshipCount:
        (profileRow.relationshipCount as Record<string, number> | null) ?? undefined,
      relationshipsTruncated: profileRow.relationshipsTruncated,
    },
    owners: owners.map((o) => ({
      entityId: o.entityId,
      label: o.label,
      riskFactors: o.riskFactors,
      isStateOwned: o.isStateOwned,
    })),
    countryIndicators: indicators.map((i) => ({
      code: i.indicatorCode,
      value: i.value,
      lowerBound: i.lowerBound,
      upperBound: i.upperBound,
      year: i.year,
    })),
    nearestPlant: nearest,
    news: {
      ranOnResolvedLegalName: true,
      articles: newsRows.map((n) => scoreArticle(n.riskFlags)),
    },
    presentEnrichments,
  };
}

/** The family badge is computed, never stored — like the Score and the Shortlist. */
function finalizeEnrichResult(
  supplier: typeof t.supplier.$inferSelect,
  fanOut: FanOutResult,
  criterionValuesWritten: number,
): EnrichResult {
  // Reads from `family_member` rows on demand.
  const exposure = computeFamilyExposure(fanOut.family.members, {
    explored: fanOut.family.members.length,
    reachable: fanOut.family.truncated ? null : fanOut.family.members.length,
  });

  return {
    supplierId: supplier.id,
    enrichmentsWritten: fanOut.written,
    criterionValuesWritten,
    familyMembers: fanOut.family.members.length,
    skipped:
      exposure.state === 'not_covered'
        ? 'family not covered — the ownership graph returned nobody'
        : undefined,
  };
}

/** Serious flags weigh ×3, moderate ×1, unflagged ×0.5 (SPEC §9.2). */
function scoreArticle(riskFlags: unknown): { seriousFlags: number; moderateFlags: number } {
  const flags = Array.isArray(riskFlags) ? riskFlags.map(String) : [];
  const serious = flags.filter((f) =>
    /sanction|forced_labor|export_control|corruption|fraud/i.test(f),
  ).length;
  return { seriousFlags: serious, moderateFlags: flags.length - serious };
}

function unresolvedInput(supplier: typeof t.supplier.$inferSelect): SupplierScoringInput {
  return {
    supplierId: supplier.id,
    displayName: supplier.rosterName ?? '(promoted lead)',
    match: { status: 'needs_review' },
    owners: [],
    countryIndicators: [],
    presentEnrichments: [],
  };
}

/**
 * Writes every Criterion value.
 *
 * Tariff exposure is written **per Category**, because it differs per Category;
 * the other five are written **once at `category = null`**, because they do not.
 * That nullability is what lets an uncategorised Supplier carry five values and
 * no Score at all.
 */
async function writeAllCriteria(
  db: Database,
  args: {
    supplier: typeof t.supplier.$inferSelect;
    programId: string;
    categoryIds: string[];
    input: SupplierScoringInput;
    tariffByCategory?: Map<string, { hsCode: string; mfnRatePct: number | null }> | undefined;
    jobId?: string | undefined;
  },
): Promise<number> {
  let written = 0;

  const nonTariff = scoreSupplier(args.input, undefined, {
    hasCategory: args.categoryIds.length > 0,
  });
  for (const criterion of nonTariff.criteria) {
    if (criterion.key === 'tariff_exposure') continue;
    await writeCriterionValue(db, {
      supplierId: args.supplier.id,
      programId: args.programId,
      categoryId: null,
      criterionKey: criterion.key,
      value: criterion.outcome.status === 'value' ? criterion.outcome.value : null,
      unknownReason: criterion.outcome.status === 'unknown' ? criterion.outcome.reason : null,
      rawInputs: criterion.outcome.rawInputs,
      anchorLine: criterion.outcome.anchorLine,
      jobId: args.jobId,
    });
    written += 1;
  }

  for (const categoryId of args.categoryIds) {
    const tariff = args.tariffByCategory?.get(categoryId);
    const perCategory = scoreSupplier(
      {
        ...args.input,
        tariff: tariff ? { hsCode: tariff.hsCode, mfnRatePct: tariff.mfnRatePct } : undefined,
      },
      undefined,
      { hasCategory: true },
    );
    const criterion = perCategory.criteria.find((c) => c.key === 'tariff_exposure')!;

    /**
     * The Category's tariff **flags**, stored beside the rate.
     *
     * The flags exist to say *a rate is not the whole story* — Section 232 on
     * autos and parts, a Section 301 action, an AD/CVD order that might land.
     * They were reachable to a reader and to no check: an Assessment that wrote
     * *"the 5% MFN rate is an as-of figure; Section 232 and Section 301 sit
     * outside it"* was rejected in every Round, because `232` and `301` matched
     * nothing the number check could see.
     *
     * The caveat was correct and the flags are the app's own authored text.
     * This is the same shape as the anchor lines (finding 22): **a sentence
     * quoting evidence must be able to cite the row that holds it**, and the
     * only row this belongs on is the one whose rate the caveat qualifies.
     */
    const flags = await db
      .select({
        key: t.tariffFlag.key,
        label: t.tariffFlag.label,
        whyNotARate: t.tariffFlag.whyNotARate,
      })
      .from(t.categoryFlag)
      .innerJoin(t.tariffFlag, eq(t.tariffFlag.key, t.categoryFlag.flagKey))
      .where(eq(t.categoryFlag.categoryId, categoryId))
      .orderBy(asc(t.tariffFlag.key));

    await writeCriterionValue(db, {
      supplierId: args.supplier.id,
      programId: args.programId,
      categoryId,
      criterionKey: 'tariff_exposure',
      value: criterion.outcome.status === 'value' ? criterion.outcome.value : null,
      unknownReason: criterion.outcome.status === 'unknown' ? criterion.outcome.reason : null,
      rawInputs: { ...criterion.outcome.rawInputs, flags },
      anchorLine: criterion.outcome.anchorLine,
      jobId: args.jobId,
    });
    written += 1;
  }

  return written;
}

export { parseRiskObject };

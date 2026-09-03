import {
  COUNTRY_ANCHOR_LINE,
  COUNTRY_INDICATORS,
  MEDIA_ANCHOR_LINE,
  MEDIA_FLAG_WEIGHTS,
  PROXIMITY_ANCHOR_LINE,
  TARIFF_ANCHOR_LINE,
  clamp100,
  mediaScore,
  normaliseIndicator,
  proximityScore,
  tariffScore,
} from './anchors';
import {
  DEDUCTION_BY_LEVEL,
  STATE_OWNERSHIP_DEDUCTION,
  dedupePsaAgainstBase,
  effectiveLevel,
  isCountryDerived,
  isDisqualifying,
  variantOf,
  type RiskFactor,
  type RiskLevel,
} from './risk-factors';
import type { CriterionOutcome, DataConfidenceBand, SupplierScoringInput } from './types';

/**
 * The six weighted Criteria (SPEC §9.2).
 *
 * Each returns a value **or `unknown` with a reason**, and each carries its raw
 * inputs, because the app may never render a Criterion number alone.
 *
 * One rule runs through all six and is the reason several of them return
 * `unknown` where a naive reading would return a good score:
 *
 *   > **A source may only emit a *clean* value when its coverage precondition
 *   > holds; otherwise `unknown`.**
 *
 * An empty result set is never a clean result. That is what stops a Supplier
 * with zero `negativeNews` articles reading as spotless when the real
 * explanation is that nobody looked under that name.
 */

const UNKNOWN = (
  reason: string,
  rawInputs: Record<string, unknown>,
  anchorLine: string,
): CriterionOutcome => ({
  status: 'unknown',
  reason,
  rawInputs,
  anchorLine,
});

const VALUE = (
  value: number,
  clamped: boolean,
  rawInputs: Record<string, unknown>,
  anchorLine: string,
): CriterionOutcome => ({ status: 'value', value, clamped, rawInputs, anchorLine });

/**
 * **`profileCountry` and `countrySource` render only where they diverge**
 * from `country` (SPEC §9.4) — the country the Match settled on and Sayari's
 * Profile agreeing is not a fact a reader needs restated beside every number, and
 * adding it unconditionally would ripple into every already-recorded
 * Assessment and Recommendation replay for a Supplier whose two countries
 * simply agree, for no reader benefit.
 */
function countryProvenance(input: SupplierScoringInput): Record<string, unknown> {
  const country = input.profile?.country ?? null;
  const profileCountry = input.profile?.profileCountry ?? null;
  if (country == null || profileCountry == null || country === profileCountry) return {};
  return { profileCountry, countrySource: input.profile?.countrySource ?? 'profile' };
}

export const COMPLIANCE_ANCHOR_LINE =
  'starts at 100; high −40, elevated −20, relevant −8, floored at 0. `_indirect` and `_adjacent` score one band down; `_subtier` badges and never deducts';

/**
 * **Compliance risk** — the heaviest Criterion at 28, and the only one where a
 * single finding can be disqualifying rather than merely bad.
 *
 * Scores **every entity-level factor except the country-derived ones**. The
 * exclusion is not cosmetic: `cpi_score`, `eu_high_risk_third` and `basel_aml`
 * are properties of a country, and scoring them here would double-count
 * Country resilience.
 *
 * The input set is wider than it first looks, and deliberately so: eleven of
 * twelve sampled Suppliers carry **no `_direct` factor at all**, so scoring
 * only `_direct` made this Criterion a constant 100 across the roster — the
 * heaviest weight in the app, doing nothing.
 */
export function complianceRisk(
  input: SupplierScoringInput,
  band: DataConfidenceBand,
): CriterionOutcome {
  const raw: Record<string, unknown> = {};

  if (input.match.status !== 'accepted' || !input.profile) {
    return UNKNOWN(
      'the Match is not accepted, so there is no Profile to score',
      raw,
      COMPLIANCE_ANCHOR_LINE,
    );
  }
  if (band === 'thin') {
    // The coverage precondition. Without it, a Supplier we know almost nothing
    // about would score 100 for having no recorded risk.
    return UNKNOWN(
      'data confidence is thin, so an absent risk factor is not evidence of absence',
      raw,
      COMPLIANCE_ANCHOR_LINE,
    );
  }

  const scored = dedupePsaAgainstBase(
    input.profile.riskFactors.filter((f) => !isCountryDerived(f)),
  );
  const countryDerived = input.profile.riskFactors.filter(isCountryDerived).map((f) => f.name);

  // An empty `risk` object is never clean on its own — but with adequate or
  // strong coverage it is a real finding, so it scores rather than dropping out.
  let value = 100;
  const deductions: { factor: string; level: string; variant: string; points: number }[] = [];
  const badgedOnly: string[] = [];
  const disqualifying: string[] = [];

  for (const factor of scored) {
    const variant = variantOf(factor.name);
    const level = effectiveLevel(factor);
    if (!level) {
      if (variant === 'subtier' && factor.level) badgedOnly.push(factor.name);
      continue;
    }
    const points = DEDUCTION_BY_LEVEL[level];
    value -= points;
    deductions.push({ factor: factor.name, level, variant, points });
    if (isDisqualifying(factor)) disqualifying.push(factor.name);
  }

  if (input.profile.sanctioned) {
    value -= DEDUCTION_BY_LEVEL.high;
    deductions.push({
      factor: 'sanctioned',
      level: 'high',
      variant: 'direct',
      points: DEDUCTION_BY_LEVEL.high,
    });
    disqualifying.push('sanctioned');
  }
  if (input.profile.pep) {
    value -= DEDUCTION_BY_LEVEL.elevated;
    deductions.push({
      factor: 'pep',
      level: 'elevated',
      variant: 'direct',
      points: DEDUCTION_BY_LEVEL.elevated,
    });
  }
  if (input.profile.closed) {
    value -= DEDUCTION_BY_LEVEL.relevant;
    deductions.push({
      factor: 'closed',
      level: 'relevant',
      variant: 'direct',
      points: DEDUCTION_BY_LEVEL.relevant,
    });
  }

  // A `high` in a pinning family pins to 0 outright rather than merely
  // deducting, because the alternative is a company with a sanctions hit still
  // ranking mid-table on the strength of good logistics.
  const pinned = disqualifying.length > 0;
  const { value: clampedValue, clamped } = clamp100(pinned ? 0 : value);

  return VALUE(
    clampedValue,
    clamped,
    {
      factorsScored: deductions,
      subtierBadgedNotDeducted: badgedOnly,
      countryDerivedExcluded: countryDerived,
      disqualifyingFactors: disqualifying,
      pinnedToZero: pinned,
      sanctioned: input.profile.sanctioned,
      pep: input.profile.pep,
      closed: input.profile.closed,
    },
    COMPLIANCE_ANCHOR_LINE,
  );
}

export const NETWORK_ANCHOR_LINE =
  'starts at 100; each entity on a current ownership/control Path deducts once, at its worst level × a hop discount (high −40, elevated −20, relevant −8; hop1 ×1, hop2 ×½, hop3 ×¼, hop4 ×⅛), state ownership −25 at hop1 × the same discount; trade edges are shown, never deducted; floored at 0';

/** hop1 ×1, hop2 ×½, hop3 ×¼, hop4 ×⅛ (network spec §5) — clamped to this range, since the watchlist read's own `maxDepth: 4` and the family read's psa-routed depth are both this ticket's outer bound. */
const HOP_DISCOUNT: Record<1 | 2 | 3 | 4, number> = { 1: 1, 2: 0.5, 3: 0.25, 4: 0.125 };

function hopDiscountFor(hopDepth: number): number {
  const clamped = Math.max(1, Math.min(4, Math.round(hopDepth))) as 1 | 2 | 3 | 4;
  return HOP_DISCOUNT[clamped];
}

function worstLevel(factors: readonly RiskFactor[]): RiskLevel | undefined {
  const levels = factors.map(effectiveLevel).filter((l): l is NonNullable<typeof l> => l != null);
  if (levels.includes('high')) return 'high';
  if (levels.includes('elevated')) return 'elevated';
  if (levels.includes('relevant')) return 'relevant';
  return undefined;
}

const levelRank = (level: RiskLevel | undefined): number =>
  level === 'high' ? 3 : level === 'elevated' ? 2 : level === 'relevant' ? 1 : 0;

/** How many owner-shaped edges `relationshipCount` says exist, whatever the window returned (shared by the unknown gate below). */
function ownerEdgeCountOf(profile: NonNullable<SupplierScoringInput['profile']>): number {
  return Object.entries(profile.relationshipCount ?? {})
    .filter(([type]) => /owner|shareholder|subsidiary|parent/i.test(type))
    .reduce((sum, [, count]) => sum + count, 0);
}

/** One sighting of one entity, before entities reached by more than one route are folded together. */
type NetworkCandidate = {
  entityId: string;
  label: string;
  hopDepth: number;
  level: RiskLevel | undefined;
  factorNames: string[];
  /** Whether THIS sighting's own route is current ownership/control, all the way. */
  viaOwnership: boolean;
  source: 'owner' | 'family' | 'watchlist';
};

/**
 * **Network exposure** — every entity on a current ownership or control Path
 * within four hops (network spec §5), one hop-discounted deduction each:
 * the Supplier's own one-hop upward owners (`input.owners`, unchanged from
 * the prior Ownership exposure), the downward Corporate family and the
 * either-direction watchlist walk (`input.networkPaths`,
 * `loadNetworkExposurePaths`) folded in together. State ownership stays its
 * own deduction at hop 1, as before. Trade and other non-ownership hops are
 * never invented a second classifier for — `viaOwnership` on each
 * `networkPaths` entry already carries `src/domain/relationships.ts`'s
 * verdict — so they are shown here and never deducted.
 *
 * ## Why `owners` and `networkPaths` both stay, rather than one replacing the other
 *
 * `owners` is the Supplier's own one-hop **upward** parents — `getEntity`'s
 * typed owner-edge read, not a Path — and `networkPaths` is downward
 * (`family`) or either-direction-but-Listed-only (`watchlist`). The two are
 * structurally disjoint in the ordinary case and this function dedupes them
 * by `entityId` regardless, so an entity that happens to appear in both (a
 * cyclic or otherwise unusual graph) still deducts once, not twice.
 *
 * ## The unknown gate, reversed from the prior Ownership exposure
 *
 * The prior function returned `unknown` **whenever `owners` was empty**,
 * whatever the coverage. That precondition does not survive widening to a
 * Network with two more automatic reads behind it: an empty `owners` AND an
 * empty `networkPaths` together are now read as **a real, adequately-covered
 * finding of nothing** unless one of three coverage signals says otherwise —
 * `relationshipCount` shows owner-shaped edges the window missed, `psaCount`
 * says the record is split, or `dataConfidence` is `thin`. Meeting none of
 * the three is not silence; it is two automatic reads that came back with an
 * answer, and the honest score for "nothing here" is 100, not "we don't
 * know" (network spec §5).
 *
 * ## The `rawInputs` shape (documented here because a later unit reads it
 * without reading this function first)
 *
 * - `members`: every entity that deducted — `entityId`, `label`, `level`,
 *   `hopDepth` (the SHORTEST route that qualified as ownership/control),
 *   `hopDiscount`, `points`, `factors` (risk-factor names contributing to
 *   `level`), `sources` (`'owner' | 'family' | 'watchlist'`, every route
 *   that reached this entity, not only the qualifying one).
 * - `shown`: every entity `networkPaths`/`owners` named that did **not**
 *   deduct — reached only through a trade/lateral hop, or through a Path
 *   with no hydrated edges yet — same shape as `members` minus
 *   `hopDiscount`/`points`, plus nothing pretending a level it does not have.
 * - `stateOwnership`: `owners` entries flagged `isStateOwned`, each with its
 *   own `points` (hop 1 always, since `owners` is one-hop by definition).
 * - `worstLevel`: the worst `level` among `members`, or `null`.
 * - `familyCoverage`/`watchlistCoverage`: `{ exploredCount, truncated }` off
 *   `input.networkCoverage`, present on every outcome (including the empty
 *   100 and the `unknown`), so an Assessment can caveat a clean answer with
 *   how far the two reads actually looked.
 */
export function networkExposure(
  input: SupplierScoringInput,
  band: DataConfidenceBand,
): CriterionOutcome {
  if (input.match.status !== 'accepted' || !input.profile) {
    return UNKNOWN(
      'the Match is not accepted, so there is no Profile to score',
      {},
      NETWORK_ANCHOR_LINE,
    );
  }

  const profile = input.profile;
  const networkPaths = input.networkPaths ?? [];
  const coverage = input.networkCoverage ?? {
    family: { exploredCount: null, truncated: false },
    watchlist: { exploredCount: null, truncated: false },
  };
  const coverageRaw = { familyCoverage: coverage.family, watchlistCoverage: coverage.watchlist };

  if (input.owners.length === 0 && networkPaths.length === 0) {
    const unknown = networkUnknownReason(profile, band);
    if (unknown) {
      return UNKNOWN(
        unknown,
        {
          ownerEdgeCount: ownerEdgeCountOf(profile),
          psaCount: profile.psaCount ?? 0,
          relationshipsTruncated: profile.relationshipsTruncated,
          relationshipCount: profile.relationshipCount ?? {},
          ...coverageRaw,
        },
        NETWORK_ANCHOR_LINE,
      );
    }
    // Falls through: both automatic reads answered, and nothing they found
    // (or didn't find) casts doubt on the window — see VALUE(100) below.
  }

  const byEntity = dedupeNetworkCandidates(buildNetworkCandidates(input));
  const { value: entityValue, members, shown } = scoreNetworkEntities(byEntity);
  const { value: stateValue, entries: stateOwnership } = scoreStateOwnership(input.owners);

  const worst = members.reduce<RiskLevel | null>(
    (best, m) => (best == null || levelRank(m.level) > levelRank(best) ? m.level : best),
    null,
  );

  const { value: clampedValue, clamped } = clamp100(100 - entityValue - stateValue);
  return VALUE(
    clampedValue,
    clamped,
    { members, shown, stateOwnership, worstLevel: worst, ...coverageRaw },
    NETWORK_ANCHOR_LINE,
  );
}

/** The reversed unknown gate (network spec §5) — `undefined` means "score, don't ask". */
function networkUnknownReason(
  profile: NonNullable<SupplierScoringInput['profile']>,
  band: DataConfidenceBand,
): string | undefined {
  const ownerEdgeCount = ownerEdgeCountOf(profile);
  if (ownerEdgeCount > 0) {
    return `the graph records ${ownerEdgeCount} owner edge(s) but the returned window did not include them — we did not look far enough, which is not the same as an absent owner`;
  }
  if ((profile.psaCount ?? 0) > 0) {
    return `no owner edge on this record, but the company is split across ${profile.psaCount} records and the ownership may hang off another one`;
  }
  if (band === 'thin') {
    return 'data confidence is thin, so two empty automatic reads are not evidence of a clean Network';
  }
  return undefined;
}

/** One candidate per (entity, route) sighting — `owners` plus every `networkPaths` entry, un-deduped. */
function buildNetworkCandidates(input: SupplierScoringInput): NetworkCandidate[] {
  const fromOwners = input.owners.map(
    (owner): NetworkCandidate => ({
      entityId: owner.entityId,
      label: owner.label,
      hopDepth: 1,
      level: worstLevel(owner.riskFactors),
      factorNames: owner.riskFactors.map((f) => f.name),
      // `owners` is the typed upward owner-edge read (`upwardOwnershipTypes`,
      // `src/domain/relationships.ts`) — ownership by construction.
      viaOwnership: true,
      source: 'owner',
    }),
  );
  const fromPaths = (input.networkPaths ?? []).map((p): NetworkCandidate => {
    const scored = dedupePsaAgainstBase(p.riskFactors.filter((f) => !isCountryDerived(f)));
    return {
      entityId: p.entityId,
      label: p.label,
      hopDepth: p.hopDepth,
      level: p.sanctioned ? 'high' : worstLevel(scored),
      factorNames: scored.map((f) => f.name),
      viaOwnership: p.viaOwnership,
      source: p.kind,
    };
  });
  return [...fromOwners, ...fromPaths];
}

/** One entity's dedupe state — the shape every `NetworkCandidate` for that `entityId` is folded into. */
type NetworkEntityAgg = {
  label: string;
  level: RiskLevel | undefined;
  factorNames: Set<string>;
  sources: Set<NetworkCandidate['source']>;
  deductible: boolean;
  /** The shortest hop depth among qualifying sightings once `deductible`, else the shortest among all sightings — for display either way. */
  hopDepth: number;
};

/**
 * Folds every sighting of the same entity into one: the worst level any
 * sighting reported, and — once `deductible` (some sighting was ownership/
 * control all the way) — the shortest hop depth among the QUALIFYING
 * sightings only, never a non-qualifying one's shorter-but-irrelevant hop.
 */
function dedupeNetworkCandidates(
  candidates: readonly NetworkCandidate[],
): Map<string, NetworkEntityAgg> {
  const byEntity = new Map<string, NetworkEntityAgg>();
  for (const c of candidates) {
    const existing = byEntity.get(c.entityId);
    if (!existing) {
      byEntity.set(c.entityId, {
        label: c.label,
        level: c.level,
        factorNames: new Set(c.factorNames),
        sources: new Set([c.source]),
        deductible: c.viaOwnership,
        hopDepth: c.hopDepth,
      });
      continue;
    }
    if (levelRank(c.level) > levelRank(existing.level)) existing.level = c.level;
    for (const name of c.factorNames) existing.factorNames.add(name);
    existing.sources.add(c.source);
    if (c.viaOwnership) {
      if (!existing.deductible || c.hopDepth < existing.hopDepth) existing.hopDepth = c.hopDepth;
      existing.deductible = true;
    } else if (!existing.deductible && c.hopDepth < existing.hopDepth) {
      existing.hopDepth = c.hopDepth;
    }
  }
  return byEntity;
}

type NetworkMember = {
  entityId: string;
  label: string;
  level: RiskLevel;
  hopDepth: number;
  hopDiscount: number;
  points: number;
  factors: string[];
  sources: string[];
};
type NetworkShown = {
  entityId: string;
  label: string;
  level: RiskLevel | null;
  hopDepth: number;
  factors: string[];
  sources: string[];
};

/** One deduction per deductible entity — `points` summed, so the caller only ever subtracts once. */
function scoreNetworkEntities(
  byEntity: ReadonlyMap<string, NetworkEntityAgg>,
): { value: number; members: NetworkMember[]; shown: NetworkShown[] } {
  let value = 0;
  const members: NetworkMember[] = [];
  const shown: NetworkShown[] = [];

  for (const [entityId, agg] of byEntity) {
    if (agg.deductible && agg.level) {
      const hopDiscount = hopDiscountFor(agg.hopDepth);
      const points = Number((DEDUCTION_BY_LEVEL[agg.level] * hopDiscount).toFixed(2));
      value += points;
      members.push({
        entityId,
        label: agg.label,
        level: agg.level,
        hopDepth: agg.hopDepth,
        hopDiscount,
        points,
        factors: [...agg.factorNames],
        sources: [...agg.sources],
      });
    } else {
      shown.push({
        entityId,
        label: agg.label,
        level: agg.level ?? null,
        hopDepth: agg.hopDepth,
        factors: [...agg.factorNames],
        sources: [...agg.sources],
      });
    }
  }
  return { value, members, shown };
}

type StateOwnershipEntry = { entityId: string; label: string; hopDepth: 1; hopDiscount: number; points: number };

/** State ownership stays its own deduction at hop 1, as today — `owners` is one-hop by definition. */
function scoreStateOwnership(
  owners: SupplierScoringInput['owners'],
): { value: number; entries: StateOwnershipEntry[] } {
  let value = 0;
  const entries: StateOwnershipEntry[] = [];
  for (const owner of owners) {
    if (!owner.isStateOwned) continue;
    const hopDiscount = hopDiscountFor(1);
    const points = Number((STATE_OWNERSHIP_DEDUCTION * hopDiscount).toFixed(2));
    value += points;
    entries.push({ entityId: owner.entityId, label: owner.label, hopDepth: 1, hopDiscount, points });
  }
  return { value, entries };
}

/**
 * **Country resilience** — six World Bank indicators for the country the
 * **Match settled on** (SPEC §9.4): GLEIF's legal-address country where the
 * settled Candidate has an LEI, else the anchored address's, else the Profile's
 * own.
 *
 * When that country differs from Sayari's own, `rawInputs` carries both —
 * `country` is the one scored, `profileCountry` is Sayari's — so a reader sees
 * the two apart rather than trusting one silently.
 * There is deliberately no human override: an override would write an
 * unsourced fact straight into a Score.
 */
export function countryResilience(input: SupplierScoringInput): CriterionOutcome {
  const country = input.profile?.country;
  const byCode = new Map(input.countryIndicators.map((i) => [i.code, i]));

  const present = COUNTRY_INDICATORS.map((spec) => ({
    spec,
    row: byCode.get(spec.code),
  })).filter((x) => x.row?.value != null);

  if (present.length === 0) {
    return UNKNOWN(
      country
        ? `no World Bank indicator returned a value for ${country} under mrnev=1`
        : 'the Profile has no country, so no indicator could be looked up',
      { country: country ?? null, ...countryProvenance(input) },
      COUNTRY_ANCHOR_LINE,
    );
  }

  // Sub-weights renormalise over the indicators that returned, for the same
  // reason the Criteria themselves do.
  const totalSubWeight = present.reduce((sum, x) => sum + x.spec.subWeight, 0);
  const weighted = present.reduce(
    (sum, x) => sum + normaliseIndicator(x.spec.scale, x.row!.value!) * x.spec.subWeight,
    0,
  );
  const { value, clamped } = clamp100(weighted / totalSubWeight);

  return VALUE(
    value,
    clamped,
    {
      country: country ?? null,
      ...countryProvenance(input),
      indicators: present.map((x) => ({
        code: x.spec.code,
        label: x.spec.label,
        raw: x.row!.value,
        normalised: normaliseIndicator(x.spec.scale, x.row!.value!),
        subWeight: x.spec.subWeight,
        year: x.row!.year ?? null,
        // Overlapping bands are not a real difference, and on this roster most
        // of them overlap — so the band is rendered, not just the point.
        band:
          x.row!.lowerBound != null && x.row!.upperBound != null
            ? [x.row!.lowerBound, x.row!.upperBound]
            : null,
      })),
      indicatorsMissing: COUNTRY_INDICATORS.filter((s) => !byCode.get(s.code)?.value).map(
        (s) => s.code,
      ),
    },
    COUNTRY_ANCHOR_LINE,
  );
}

/**
 * **Tariff exposure** — the Category's default HS line × the settled
 * country as origin (SPEC §9.4) × importer USA.
 *
 * **A Supplier with no Category has no Score at all**, not an unknown Criterion
 * here — that case is handled by the assembler, because it is a property of the
 * Supplier rather than of this Criterion.
 *
 * The (origin → MEX) duty is fetched and rendered beside the scored figure and
 * is **never scored**, because the Program stores one importer and the Mexican
 * Plant makes that an explicit proxy.
 */
export function tariffExposure(input: SupplierScoringInput): CriterionOutcome {
  const tariff = input.tariff;
  if (!tariff || tariff.mfnRatePct == null) {
    return UNKNOWN(
      tariff ? `no MFN rate returned for HS ${tariff.hsCode}` : 'no tariff line for this Category',
      { hsCode: tariff?.hsCode ?? null },
      TARIFF_ANCHOR_LINE,
    );
  }
  const value = tariffScore(tariff.mfnRatePct);
  return VALUE(
    value,
    tariff.mfnRatePct > 10,
    {
      hsCode: tariff.hsCode,
      mfnRatePct: tariff.mfnRatePct,
      // Rendered beside the number, never folded into it.
      mexicoRatePct: tariff.mexicoRatePct ?? null,
      candidateLines: tariff.candidateLines ?? [],
      originCountry: input.profile?.country ?? null,
      ...countryProvenance(input),
      importerCountry: 'USA',
    },
    TARIFF_ANCHOR_LINE,
  );
}

/**
 * **Proximity** — Sayari's own coordinates on the Profile, falling back to a
 * `geocode` row, great-circle to the nearest Plant.
 *
 * The coordinate's **precision renders with the value**, because 4 of 6 sampled
 * addresses missed at building precision and every seeded Plant is a city
 * centroid. A distance stated to the kilometre from two ±5 km centroids is a
 * false precision the UI must not imply.
 */
export function proximity(input: SupplierScoringInput): CriterionOutcome {
  if (!input.nearestPlant) {
    return UNKNOWN(
      'no coordinate for this Supplier from either Sayari or a geocode',
      { coordinatePrecision: input.profile?.coordinatePrecision ?? null },
      PROXIMITY_ANCHOR_LINE,
    );
  }
  const km = input.nearestPlant.km;
  return VALUE(
    proximityScore(km),
    km > 8_000,
    {
      nearestPlant: input.nearestPlant.code,
      nearestPlantCity: input.nearestPlant.city,
      km: Math.round(km),
      coordinatePrecision: input.profile?.coordinatePrecision ?? 'unknown',
    },
    PROXIMITY_ANCHOR_LINE,
  );
}

const MEDIA_UNKNOWN_NO_QUERY =
  'the negative-news query did not run on a resolved legal name, so an empty result says nothing about the company';

/**
 * **Media signal** — `negativeNews` on the resolved legal name, plus the
 * `adverse_media` risk family.
 *
 * It **owns all adverse-media evidence**, so no fact is counted twice between
 * here and Compliance risk.
 *
 * Two coverage preconditions, and both matter: the query must have run on a
 * resolved legal name (the endpoint takes a bare name, so disambiguation is
 * ours), and data confidence must not be thin. Zero articles under either
 * condition is not a clean result.
 */
export function mediaSignal(
  input: SupplierScoringInput,
  band: DataConfidenceBand,
): CriterionOutcome {
  const news = input.news;
  if (!news?.ranOnResolvedLegalName) {
    return UNKNOWN(MEDIA_UNKNOWN_NO_QUERY, { ran: false }, MEDIA_ANCHOR_LINE);
  }
  if (band === 'thin') {
    return UNKNOWN(
      'data confidence is thin, so an empty article set is not evidence of a clean record',
      { articleCount: news.articles.length },
      MEDIA_ANCHOR_LINE,
    );
  }

  const weighted = news.articles.reduce((sum, article) => {
    if (article.seriousFlags > 0) return sum + MEDIA_FLAG_WEIGHTS.serious * article.seriousFlags;
    if (article.moderateFlags > 0) return sum + MEDIA_FLAG_WEIGHTS.moderate * article.moderateFlags;
    return sum + MEDIA_FLAG_WEIGHTS.unflagged;
  }, 0);

  return VALUE(
    mediaScore(weighted),
    weighted > 20,
    {
      // The raw count is shown as context beside the weighted figure, because a
      // weighted count is not a number a reader can check against a headline.
      articleCount: news.articles.length,
      weightedCount: Number(weighted.toFixed(2)),
      serious: news.articles.filter((a) => a.seriousFlags > 0).length,
      moderate: news.articles.filter((a) => a.seriousFlags === 0 && a.moderateFlags > 0).length,
      unflagged: news.articles.filter((a) => a.seriousFlags === 0 && a.moderateFlags === 0).length,
    },
    MEDIA_ANCHOR_LINE,
  );
}

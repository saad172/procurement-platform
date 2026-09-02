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
  isTwinFactor,
  variantOf,
  type RiskFactor,
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
 * from `country` (finding 107) — the settled site and Sayari's Profile
 * agreeing is not a fact a reader needs restated beside every number, and
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

export const OWNERSHIP_ANCHOR_LINE =
  'starts at 100; each current one-hop owner deducts on its own worst level (high −40, elevated −20, relevant −8), state ownership −25, floored at 0';

/**
 * **Ownership exposure** — current one-hop owner edges, each owner's own risk,
 * state ownership, and the ownership-family `psa_` factors.
 *
 * `unknown`'s **reason is first-class here**, and it is read off
 * `relationshipCount` at zero cost. Three different situations produce no owner
 * edge and they mean different things:
 *
 * - **real absence** — the graph records no owner;
 * - **a split record** — `psaCount > 0`, so the ownership hangs off another
 *   record of the same company (measured: one company's own record held zero
 *   ownership edges against 88 221 `carrier_of` edges);
 * - **a truncated window** — `relationshipCount` says owner edges exist but the
 *   returned window was swamped by trade edges.
 *
 * Shared ownership between two bidders is deliberately **not** an input here:
 * it is a Shortlist finding, because a Criterion that read other Suppliers
 * would change when a *different* Supplier's Match settled, under an
 * append-only `criterion_value`.
 */
export function ownershipExposure(input: SupplierScoringInput): CriterionOutcome {
  const raw: Record<string, unknown> = {};
  if (input.match.status !== 'accepted' || !input.profile) {
    return UNKNOWN(
      'the Match is not accepted, so there is no Profile to score',
      raw,
      OWNERSHIP_ANCHOR_LINE,
    );
  }

  const profile = input.profile;
  // The ownership-family Twin factors — `psa_owned_by_soe` among them. This is
  // the repair for a measured gap: eleven Twins were fetched and NOT ONE
  // carried an upward owner edge, so widening Ownership exposure to these
  // factors recovers a signal that the obvious repair (fetch the Twins' owners)
  // was measured not to have.
  const ownershipPsaFactors = profile.riskFactors.filter(
    (f) => isTwinFactor(f.name) && /own|soe|state/i.test(f.name),
  );

  if (input.owners.length === 0 && ownershipPsaFactors.length === 0) {
    const ownerEdgeCount = Object.entries(profile.relationshipCount ?? {})
      .filter(([type]) => /owner|shareholder|subsidiary|parent/i.test(type))
      .reduce((sum, [, count]) => sum + count, 0);

    const reason =
      ownerEdgeCount > 0
        ? `the graph records ${ownerEdgeCount} owner edge(s) but the returned window did not include them — we did not look far enough, which is not the same as an absent owner`
        : (profile.psaCount ?? 0) > 0
          ? `no owner edge on this record, but the company is split across ${profile.psaCount} records and the ownership may hang off another one`
          : 'the graph records no owner for this company';

    return UNKNOWN(
      reason,
      {
        ownerEdgeCount,
        psaCount: profile.psaCount ?? 0,
        relationshipsTruncated: profile.relationshipsTruncated,
        relationshipCount: profile.relationshipCount ?? {},
      },
      OWNERSHIP_ANCHOR_LINE,
    );
  }

  let value = 100;
  const deductions: { owner: string; reason: string; points: number }[] = [];

  for (const owner of input.owners) {
    const worst = worstLevel(owner.riskFactors);
    if (worst) {
      const points = DEDUCTION_BY_LEVEL[worst];
      value -= points;
      deductions.push({
        owner: owner.label,
        reason: `owner carries a ${worst} risk factor`,
        points,
      });
    }
    if (owner.isStateOwned) {
      value -= STATE_OWNERSHIP_DEDUCTION;
      deductions.push({
        owner: owner.label,
        reason: 'state ownership',
        points: STATE_OWNERSHIP_DEDUCTION,
      });
    }
  }

  for (const factor of ownershipPsaFactors) {
    const level = effectiveLevel(factor);
    if (!level) continue;
    const points = DEDUCTION_BY_LEVEL[level];
    value -= points;
    deductions.push({
      owner: `(twin) ${factor.name}`,
      reason: `ownership-family factor at ${level}`,
      points,
    });
  }

  const { value: clampedValue, clamped } = clamp100(value);
  return VALUE(
    clampedValue,
    clamped,
    {
      owners: input.owners.map((o) => ({
        label: o.label,
        entityId: o.entityId,
        stateOwned: o.isStateOwned,
      })),
      ownershipPsaFactors: ownershipPsaFactors.map((f) => f.name),
      deductions,
    },
    OWNERSHIP_ANCHOR_LINE,
  );
}

function worstLevel(factors: readonly RiskFactor[]) {
  const levels = factors.map(effectiveLevel).filter((l): l is NonNullable<typeof l> => l != null);
  if (levels.includes('high')) return 'high' as const;
  if (levels.includes('elevated')) return 'elevated' as const;
  if (levels.includes('relevant')) return 'relevant' as const;
  return undefined;
}

/**
 * **Country resilience** — six World Bank indicators for the **settled site's**
 * country (finding 107), which is the roster's when the settled candidate's
 * `country` Discriminator passed, and the Profile's own otherwise.
 *
 * When the settled site's country differs from Sayari's own (finding 107),
 * `rawInputs` carries both — `country` is the one scored, `profileCountry` is
 * Sayari's — so a reader sees the two apart rather than trusting one silently.
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
 * **Tariff exposure** — the Category's default HS line × the settled site's
 * country as origin (finding 107) × importer USA.
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

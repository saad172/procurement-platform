import {
  COUNTRY_ANCHOR_LINE,
  DATA_CONFIDENCE,
  EXPECTED_ENRICHMENTS,
  MEDIA_ANCHOR_LINE,
  PROXIMITY_ANCHOR_LINE,
  TARIFF_ANCHOR_LINE,
} from './scoring/anchors';
import { COMPLIANCE_ANCHOR_LINE, OWNERSHIP_ANCHOR_LINE } from './scoring/criteria';
import {
  complianceRisk,
  countryResilience,
  mediaSignal,
  ownershipExposure,
  proximity,
  tariffExposure,
} from './scoring/criteria';
import { isDisqualifying } from './scoring/risk-factors';
import type {
  CriterionKey,
  CriterionOutcome,
  DataConfidenceBand,
  ScoredCriterion,
  SupplierScore,
  SupplierScoringInput,
  WeightVector,
} from './scoring/types';

/**
 * **One pure `score.ts`, called by server and browser alike** (SPEC §9.4).
 *
 * There is no `score` table and no `shortlist` table. Both are computed here,
 * which is what lets a weight drag re-rank in the browser with no round trip
 * and no Job re-run — and what stops a stored Score drifting away from the
 * `criterion_value` rows a published sentence cites.
 *
 * Renormalisation lives **inside** this function, so a what-if vector from the
 * URL and a saved vector from the database behave identically. That is also why
 * a missing weight key is safe: it is structurally identical to a Criterion
 * that dropped out as `unknown`.
 */

export const WEIGHTED_CRITERIA: readonly CriterionKey[] = [
  'compliance_risk',
  'network_exposure',
  'country_resilience',
  'tariff_exposure',
  'proximity',
  'media_signal',
];

/**
 * The buyer-facing name of each weighted Criterion, in the order every page
 * and chat widget lists them.
 *
 * **Not the same string as `program_criterion_weight.label`**
 * (`src/db/seed-data/program.ts` `CRITERIA`, around line 262), even though the
 * seed carries the same six words: that row is read by `loadCriterionWeights()`
 * (`src/jobs/assess.ts`) into the Assessment prompt, so it is what an *agent*
 * reads and could in principle diverge from Program to Program. This constant
 * is what the *screen* renders — the weight rail, `CriterionCell`, and every
 * widget that mirrors either — and it is the one of the two authoritative for
 * what a person sees. The weight rail and the widgets' `criterion-format.ts`
 * (then `parts-table.tsx`) each declared this table for themselves before it
 * moved here.
 */
export const CRITERION_LABELS: Record<CriterionKey, string> = {
  compliance_risk: 'Compliance risk',
  network_exposure: 'Network exposure',
  country_resilience: 'Country resilience',
  tariff_exposure: 'Tariff exposure',
  proximity: 'Proximity',
  media_signal: 'Media signal',
};

/**
 * The Program default. Presets are code constants rather than rows because the
 * seed's own presets had already gone stale — summing to 101 and 112 — when a
 * Criterion was dropped, and a stored row would have survived that silently.
 */
export const DEFAULT_WEIGHTS: Required<WeightVector> = {
  compliance_risk: 28,
  network_exposure: 17,
  country_resilience: 17,
  tariff_exposure: 17,
  proximity: 11,
  media_signal: 10,
};

/**
 * Boot-validated presets (SPEC §13.4). `assertPresetsAreLegal()` throws at boot
 * unless each sums to 100 across exactly the six weighted Criteria — the same
 * refuse-to-boot idiom as a missing credential.
 */
export const WEIGHT_PRESETS: Record<string, Required<WeightVector>> = {
  balanced: DEFAULT_WEIGHTS,
  'cost-led': {
    compliance_risk: 20,
    network_exposure: 12,
    country_resilience: 12,
    tariff_exposure: 26,
    proximity: 20,
    media_signal: 10,
  },
  'compliance-led': {
    compliance_risk: 40,
    network_exposure: 22,
    country_resilience: 15,
    tariff_exposure: 10,
    proximity: 5,
    media_signal: 8,
  },
};

/** Throws at boot if a preset drifts away from the Criterion list. */
export function assertPresetsAreLegal(): void {
  for (const [name, preset] of Object.entries(WEIGHT_PRESETS)) {
    const keys = Object.keys(preset).sort();
    const expected = [...WEIGHTED_CRITERIA].sort();
    if (keys.length !== expected.length || keys.some((k, i) => k !== expected[i])) {
      throw new Error(
        `Weight preset "${name}" does not quantify over exactly the six weighted Criteria.\n` +
          `  has:      ${keys.join(', ')}\n  expected: ${expected.join(', ')}`,
      );
    }
    const total = Object.values(preset).reduce((sum, w) => sum + w, 0);
    if (Math.abs(total - 100) > 1e-9) {
      throw new Error(`Weight preset "${name}" sums to ${total}, not 100.`);
    }
  }
}

/**
 * Reads a weight vector from the URL or the database.
 *
 * **Keyed, not positional.** A positional vector (`w=28.17.17.17.11.10`)
 * silently misreads every saved link the moment a Criterion is added or
 * removed. On read: unknown keys are dropped, missing keys are filled from the
 * Program default, and the result renormalises through the same path a dropped
 * Criterion takes.
 */
export function normaliseWeights(
  supplied: WeightVector | undefined,
  programDefault: WeightVector = DEFAULT_WEIGHTS,
): Required<WeightVector> {
  const out = {} as Required<WeightVector>;
  for (const key of WEIGHTED_CRITERIA) {
    const value = supplied?.[key] ?? programDefault[key] ?? DEFAULT_WEIGHTS[key];
    out[key] = Number.isFinite(value) && value >= 0 ? value : DEFAULT_WEIGHTS[key];
  }
  return out;
}

/**
 * **Data confidence** — a badge, never a Criterion (SPEC §9.2).
 *
 * It adds no points and moves no rank. Its job is to **gate what may be called
 * *clean***, so a Supplier in a thin registry loses Criteria to `unknown`
 * instead of losing points. That is the whole reason it was demoted: as a
 * scored Criterion it penalised a company for what we do not know about it.
 *
 * It counts **distinct sources** and a **checklist of expected Enrichments** —
 * never a row count, because country and tariff Enrichments are shared across
 * Suppliers and would inflate every band.
 */
export function dataConfidence(input: SupplierScoringInput): DataConfidenceBand {
  if (input.match.status !== 'accepted' || !input.profile) return 'thin';

  const sources = input.profile.distinctSourceCount ?? 0;
  const present = new Set(input.presentEnrichments);
  const expectedPresent = EXPECTED_ENRICHMENTS.filter((e) => present.has(e)).length;

  if (
    sources >= DATA_CONFIDENCE.strong.minDistinctSources &&
    expectedPresent === EXPECTED_ENRICHMENTS.length
  ) {
    return 'strong';
  }
  if (
    sources >= DATA_CONFIDENCE.adequate.minDistinctSources &&
    expectedPresent >= DATA_CONFIDENCE.adequate.minEnrichments
  ) {
    return 'adequate';
  }
  return 'thin';
}

/**
 * The band's badge tone. `strong` reads good, `thin` reads warn, and
 * `adequate` sits between as mute — the three tones every page already uses
 * for this badge, so a widget or a rail cannot quietly invent a fourth.
 * The widgets' `criterion-format.ts` (then `parts-table.tsx`) and the
 * Category page's Shortlist row each carried this mapping themselves before
 * it moved here.
 */
export function confidenceTone(band: DataConfidenceBand | string): string {
  if (band === 'strong') return 'good';
  if (band === 'thin') return 'warn';
  return 'mute';
}

/**
 * Computes one Supplier's Criteria and Score for one Program × Category.
 *
 * `hasCategory` is separate from the tariff input because the two mean
 * different things: **a Supplier with no Category has no Score at all**, not an
 * unknown Criterion — it carries the five non-tariff values at `category = null`
 * and appears in the Excluded block for a different reason than an unresolved
 * one.
 */
export function scoreSupplier(
  input: SupplierScoringInput,
  weights: WeightVector = DEFAULT_WEIGHTS,
  options: { hasCategory: boolean } = { hasCategory: true },
): SupplierScore {
  const w = normaliseWeights(weights);
  const band = dataConfidence(input);

  /**
   * **A Supplier with no settled Match shows no estimated Criterion** at all
   * (SPEC §13.3), not just no Score.
   *
   * The gate is here rather than repeated inside each Criterion because it is a
   * property of the Supplier, not of any one Criterion — and because three of
   * the six take caller-supplied inputs (a distance, an article list) that a
   * caller could still populate for an unresolved row. Clicking such a row
   * opens the resolver's candidates and Rounds, not a score breakdown, and an
   * estimated Criterion sitting behind it would be a number about a company we
   * have not identified.
   */
  const unresolved = input.match.status !== 'accepted' || !input.profile;
  const NOT_RESOLVED = (anchorLine: string): CriterionOutcome => ({
    status: 'unknown',
    reason: `the Match is ${input.match.status}, so there is no Profile to measure`,
    rawInputs: { matchStatus: input.match.status },
    anchorLine,
  });

  const outcomes: Record<CriterionKey, CriterionOutcome> = unresolved
    ? {
        compliance_risk: NOT_RESOLVED(COMPLIANCE_ANCHOR_LINE),
        network_exposure: NOT_RESOLVED(OWNERSHIP_ANCHOR_LINE),
        country_resilience: NOT_RESOLVED(COUNTRY_ANCHOR_LINE),
        tariff_exposure: NOT_RESOLVED(TARIFF_ANCHOR_LINE),
        proximity: NOT_RESOLVED(PROXIMITY_ANCHOR_LINE),
        media_signal: NOT_RESOLVED(MEDIA_ANCHOR_LINE),
      }
    : {
        compliance_risk: complianceRisk(input, band),
        network_exposure: ownershipExposure(input),
        country_resilience: countryResilience(input),
        tariff_exposure: tariffExposure(input),
        proximity: proximity(input),
        media_signal: mediaSignal(input, band),
      };

  // Only the Criteria that returned a value carry weight. The rest drop out and
  // the survivors renormalise — never a neutral 50, which would be a fabricated
  // fact a Citation could point at.
  const computedKeys = WEIGHTED_CRITERIA.filter((key) => outcomes[key].status === 'value');
  const totalWeight = computedKeys.reduce((sum, key) => sum + w[key], 0);

  const criteria: ScoredCriterion[] = WEIGHTED_CRITERIA.map((key) => {
    const outcome = outcomes[key];
    const effectiveWeight =
      outcome.status === 'value' && totalWeight > 0 ? (w[key] / totalWeight) * 100 : 0;
    return {
      key,
      outcome,
      effectiveWeight,
      contribution: outcome.status === 'value' ? (outcome.value * effectiveWeight) / 100 : 0,
    };
  });

  const disqualifyingFactors = input.profile
    ? input.profile.riskFactors.filter(isDisqualifying).map((f) => f.name)
    : [];
  if (input.profile?.sanctioned) disqualifyingFactors.push('sanctioned');

  const scoreAbsentReason =
    input.match.status !== 'accepted'
      ? ('no_match' as const)
      : !options.hasCategory
        ? ('no_category' as const)
        : undefined;

  const score =
    scoreAbsentReason || totalWeight === 0
      ? null
      : criteria.reduce((sum, c) => sum + c.contribution, 0);

  return {
    supplierId: input.supplierId,
    displayName: input.displayName,
    score,
    ...(scoreAbsentReason ? { scoreAbsentReason } : {}),
    criteria: [...criteria].sort((a, b) => b.contribution - a.contribution),
    coverage: { computed: computedKeys.length, total: WEIGHTED_CRITERIA.length },
    dataConfidence: band,
    disqualifying: disqualifyingFactors.length > 0,
    disqualifyingFactors,
    renormalisedWeights: Object.fromEntries(
      criteria.map((c) => [c.key, Number(c.effectiveWeight.toFixed(4))]),
    ),
  };
}

/**
 * One stored `criterion_value` row, as a page reads it.
 *
 * Deliberately the *stored* value rather than a recomputation: **a page must
 * render what a Citation points at.** Recomputing a Criterion at render time
 * could show a figure that differs from the one a published sentence cites,
 * which is exactly the drift `criterion_value` is append-only to prevent.
 */
export type StoredCriterionValue = {
  criterionKey: string;
  categoryId: string | null;
  value: number | null;
  unknownReason: string | null;
  rawInputs: Record<string, unknown>;
  anchorLine: string;
};

/**
 * Scores a Supplier from its **stored** Criterion values and a weight vector.
 *
 * This is what every page uses, and what makes the live weight rail cheap: a
 * weight drag needs no upstream call, no Job, and no re-derivation — only the
 * rows already on the page and the same renormalisation `scoreSupplier` uses.
 *
 * `scoreSupplier` computes the values in the first place, during a Job. This
 * assembles them afterwards. Keeping them separate is what stops a page's
 * arithmetic drifting away from a Job's.
 */
export function scoreFromStoredValues(
  args: {
    supplierId: string;
    displayName: string;
    values: readonly StoredCriterionValue[];
    dataConfidence: DataConfidenceBand;
    disqualifyingFactors: readonly string[];
    matchAccepted: boolean;
    hasCategory: boolean;
    /** Null on a Supplier page showing values that are not Category-specific. */
    categoryId?: string | null | undefined;
  },
  weights: WeightVector = DEFAULT_WEIGHTS,
): SupplierScore {
  const w = normaliseWeights(weights);

  // Tariff exposure is stored per Category; the other five at `category = null`.
  const byKey = new Map<string, StoredCriterionValue>();
  for (const value of args.values) {
    if (value.categoryId != null && args.categoryId != null && value.categoryId !== args.categoryId)
      continue;
    const existing = byKey.get(value.criterionKey);
    // Prefer the Category-specific row where both exist.
    if (!existing || (value.categoryId != null && existing.categoryId == null)) {
      byKey.set(value.criterionKey, value);
    }
  }

  const outcomes = Object.fromEntries(
    WEIGHTED_CRITERIA.map((key) => {
      const stored = byKey.get(key);
      if (!stored) {
        return [
          key,
          {
            status: 'unknown',
            reason: 'this criterion has not been computed yet',
            rawInputs: {},
            anchorLine: '',
          } satisfies CriterionOutcome,
        ];
      }
      return [
        key,
        stored.value == null
          ? ({
              status: 'unknown',
              reason: stored.unknownReason ?? 'unknown',
              rawInputs: stored.rawInputs,
              anchorLine: stored.anchorLine,
            } satisfies CriterionOutcome)
          : ({
              status: 'value',
              value: stored.value,
              clamped: false,
              rawInputs: stored.rawInputs,
              anchorLine: stored.anchorLine,
            } satisfies CriterionOutcome),
      ];
    }),
  ) as Record<CriterionKey, CriterionOutcome>;

  const computedKeys = WEIGHTED_CRITERIA.filter((key) => outcomes[key].status === 'value');
  const totalWeight = computedKeys.reduce((sum, key) => sum + w[key], 0);

  const criteria: ScoredCriterion[] = WEIGHTED_CRITERIA.map((key) => {
    const outcome = outcomes[key];
    const effectiveWeight =
      outcome.status === 'value' && totalWeight > 0 ? (w[key] / totalWeight) * 100 : 0;
    return {
      key,
      outcome,
      effectiveWeight,
      contribution: outcome.status === 'value' ? (outcome.value * effectiveWeight) / 100 : 0,
    };
  });

  const scoreAbsentReason = !args.matchAccepted
    ? ('no_match' as const)
    : !args.hasCategory
      ? ('no_category' as const)
      : undefined;

  return {
    supplierId: args.supplierId,
    displayName: args.displayName,
    score:
      scoreAbsentReason || totalWeight === 0
        ? null
        : criteria.reduce((sum, c) => sum + c.contribution, 0),
    ...(scoreAbsentReason ? { scoreAbsentReason } : {}),
    criteria: [...criteria].sort((a, b) => b.contribution - a.contribution),
    coverage: { computed: computedKeys.length, total: WEIGHTED_CRITERIA.length },
    dataConfidence: args.dataConfidence,
    disqualifying: args.disqualifyingFactors.length > 0,
    disqualifyingFactors: [...args.disqualifyingFactors],
    renormalisedWeights: Object.fromEntries(
      criteria.map((c) => [c.key, Number(c.effectiveWeight.toFixed(4))]),
    ),
  };
}

export type ShortlistRow = SupplierScore & { rank: number | null };

/**
 * The Shortlist: the Suppliers of one Program × Category ranked by Score.
 *
 * **A filter never narrows it.** Filtering hides rows from view without
 * changing a rank and without changing what a Recommendation argues from —
 * which is why a filtered row keeps its true rank and the visible rows read
 * 2, 5, 7 with the gaps left in. The gap is the disclosure.
 *
 * **Ties:** float internally, one decimal displayed, equal displayed Scores
 * share a rank. Stored order is Score desc → compliance desc → name asc, so the
 * order is total and stable even when two Scores are identical.
 */
export function buildShortlist(scores: readonly SupplierScore[]): {
  ranked: ShortlistRow[];
  excluded: { row: SupplierScore; reason: 'no_match' | 'no_category' }[];
} {
  const scored = scores.filter((s) => s.score != null);
  const excluded = scores
    .filter((s) => s.score == null)
    .map((s) => ({ row: s, reason: s.scoreAbsentReason ?? ('no_match' as const) }));

  const complianceOf = (s: SupplierScore) => {
    const c = s.criteria.find((x) => x.key === 'compliance_risk');
    return c?.outcome.status === 'value' ? c.outcome.value : -1;
  };

  const sorted = [...scored].sort(
    (a, b) =>
      b.score! - a.score! ||
      complianceOf(b) - complianceOf(a) ||
      a.displayName.localeCompare(b.displayName),
  );

  // Equal *displayed* Scores share a rank, because two rows showing 84.2 that
  // rank 3 and 4 look like a distinction the number does not support.
  const ranked: ShortlistRow[] = [];
  let lastDisplayed: string | undefined;
  let lastRank = 0;
  sorted.forEach((row, index) => {
    const displayed = row.score!.toFixed(1);
    if (displayed !== lastDisplayed) {
      lastRank = index + 1;
      lastDisplayed = displayed;
    }
    ranked.push({ ...row, rank: lastRank });
  });

  return { ranked, excluded };
}

export { EXPECTED_ENRICHMENTS, criterionBand } from './scoring/anchors';
export type {
  CriterionKey,
  CriterionOutcome,
  DataConfidenceBand,
  ScoredCriterion,
  SupplierScore,
  SupplierScoringInput,
  WeightVector,
} from './scoring/types';

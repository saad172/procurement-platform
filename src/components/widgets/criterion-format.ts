import type { CriterionKey, CriterionOutcome, ScoredCriterion } from '@/domain/score';
import { CRITERION_LABELS, WEIGHTED_CRITERIA } from '@/domain/score';

/**
 * Turning a frozen `criterion_value` row into what a widget draws: a label
 * to put beside it, and a `ScoredCriterion` `CriterionCell` (the same
 * component every page uses) can render without a second definition of a
 * Criterion's band. `supplier_card` and `criterion_compare` both parse a raw
 * `criterion_value` row over `unknown` and both used to build this object
 * for themselves — one here now, so `CriterionCell` is the only place a band
 * is ever computed.
 */

export function fmtScore(score: number | null | undefined): string {
  return typeof score === 'number' ? score.toFixed(1) : '—';
}

/** "n of 6 measured" — a Score never rides without the coverage that produced it. */
export function coverageNote(computed: number, total: number): string {
  return `${computed} of ${total} measured`;
}

/** True only for one of the six weighted Criteria — never assumed from a frozen row's own string. */
function isCriterionKey(key: string): key is CriterionKey {
  return (WEIGHTED_CRITERIA as readonly string[]).includes(key);
}

/**
 * `CRITERION_LABELS[key]`, the one label every page and widget uses — falling
 * back to the raw key, spaced out, only for a key the six do not name. That
 * fallback is what a payload frozen before a seventh Criterion existed would
 * need, not a live path today.
 */
export function criterionLabel(key: string): string {
  return isCriterionKey(key) ? CRITERION_LABELS[key] : key.replace(/_/g, ' ');
}

/** The shape `toScoredCriterion` narrows a frozen row into. */
type FrozenCriterionValue = {
  criterionKey: string;
  value: number | null;
  unknownReason: string | null;
  rawInputs: Record<string, unknown>;
  anchorLine: string;
};

/**
 * `effectiveWeight` and `contribution` are zeroed rather than recomputed: a
 * stored `criterion_value` carries no weight of its own — the weight is a
 * Program property, read from the URL or the database, and a widget shows
 * the value `CriterionCell` renders without claiming a Score it was not
 * handed the vector to compute.
 *
 * `key` is narrowed against `WEIGHTED_CRITERIA` where possible; an
 * unrecognised key falls back to the first weighted Criterion rather than an
 * `as never` cast, because `CriterionCell` never reads `.key` — only
 * `.outcome` is rendered — so a wrong key here is inert, not a fought type.
 */
export function toScoredCriterion(v: FrozenCriterionValue): ScoredCriterion {
  const outcome: CriterionOutcome =
    v.value == null
      ? {
          status: 'unknown',
          reason: v.unknownReason ?? 'unknown',
          rawInputs: v.rawInputs,
          anchorLine: v.anchorLine,
        }
      : {
          status: 'value',
          value: v.value,
          clamped: false,
          rawInputs: v.rawInputs,
          anchorLine: v.anchorLine,
        };
  const key = isCriterionKey(v.criterionKey) ? v.criterionKey : WEIGHTED_CRITERIA[0]!;
  return { key, outcome, effectiveWeight: 0, contribution: 0 };
}

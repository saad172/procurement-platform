import type { CriterionKey, DataConfidenceBand } from '@/domain/score';
import { WEIGHTED_CRITERIA } from '@/domain/score';

/**
 * What every widget that reads a Score, a Criterion or a weight vector needs
 * in common — one place for the bands the pages already draw, so a widget
 * cannot quietly invent its own scale beside theirs.
 */

export { WEIGHTED_CRITERIA };

/** The six weighted Criteria, in the order every page lists them. */
export const CRITERION_LABELS: Record<CriterionKey, string> = {
  compliance_risk: 'Compliance risk',
  ownership_exposure: 'Ownership exposure',
  country_resilience: 'Country resilience',
  tariff_exposure: 'Tariff exposure',
  proximity: 'Proximity',
  media_signal: 'Media signal',
};

/** `criterion-cell.tsx`'s own bands — a Criterion value is never a bare number. */
export function criterionBand(value: number): string {
  if (value >= 80) return 'low risk';
  if (value >= 60) return 'moderate';
  if (value >= 40) return 'elevated';
  return 'high';
}

/** `strong` reads good, `thin` reads warn, `adequate` sits between as mute. */
export function confidenceTone(band: DataConfidenceBand | string): string {
  if (band === 'strong') return 'good';
  if (band === 'thin') return 'warn';
  return 'mute';
}

export function fmtScore(score: number | null | undefined): string {
  return typeof score === 'number' ? score.toFixed(1) : '—';
}

/** "n of 6 measured" — a Score never rides without the coverage that produced it. */
export function coverageNote(computed: number, total: number): string {
  return `${computed} of ${total} measured`;
}

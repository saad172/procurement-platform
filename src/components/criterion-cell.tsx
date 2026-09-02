import { criterionBand, type ScoredCriterion } from '@/domain/score';

/**
 * **The app may never render a Criterion number alone** (SPEC §9.1).
 *
 * Every value renders as a band plus its raw input, so *Compliance risk 92*
 * cannot be misread as *very risky*. That is why this component exists at all:
 * a bare `{value}` anywhere in the app would be a bug, and having one component
 * that cannot produce one is cheaper than remembering.
 *
 * An `unknown` Criterion renders its **reason**, because a Criterion that
 * dropped out is a fact about the evidence, not an absence to skip past.
 */
export function CriterionCell({ criterion }: { criterion: ScoredCriterion }) {
  const { outcome } = criterion;

  if (outcome.status === 'unknown') {
    return (
      <div>
        <span className="criterion-unknown">unknown</span>
        <div className="criterion-raw">{outcome.reason}</div>
      </div>
    );
  }

  return (
    <div>
      <span className="criterion-value">{outcome.value.toFixed(1)}</span>{' '}
      <span className="badge mute">{criterionBand(outcome.value)}</span>
      <div className="criterion-raw">{describeRawInputs(outcome.rawInputs)}</div>
      <div className="criterion-raw" style={{ opacity: 0.75 }}>
        {outcome.anchorLine}
      </div>
      {outcome.clamped ? <span className="badge warn">clamped to the anchor</span> : null}
    </div>
  );
}

/** The raw input in the words a reader can check against the source. */
function describeRawInputs(raw: Record<string, unknown>): string {
  if (typeof raw.mfnRatePct === 'number') {
    return `MFN ${raw.mfnRatePct}% on HS ${String(raw.hsCode ?? '?')}`;
  }
  if (typeof raw.km === 'number') {
    return `${raw.km.toLocaleString('en-US')} km to ${String(raw.nearestPlantCity ?? raw.nearestPlant ?? 'the nearest plant')} · ${String(raw.coordinatePrecision ?? 'unknown')} precision`;
  }
  if (Array.isArray(raw.factorsScored)) {
    const count = raw.factorsScored.length;
    return count === 0
      ? 'no risk factor deducted'
      : `${count} risk factor${count === 1 ? '' : 's'} deducted`;
  }
  if (typeof raw.articleCount === 'number') {
    return `${raw.articleCount} article${raw.articleCount === 1 ? '' : 's'}, weighted ${String(raw.weightedCount ?? '?')}`;
  }
  if (Array.isArray(raw.indicators)) {
    return `${raw.indicators.length} of 6 World Bank indicators returned`;
  }
  if (Array.isArray(raw.owners)) {
    return `${raw.owners.length} current owner edge${raw.owners.length === 1 ? '' : 's'}`;
  }
  return '';
}

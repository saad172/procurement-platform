import { describe, expect, it } from 'vitest';
import {
  hasFilter,
  historyModeFor,
  isWhatIf,
  parseViewState,
  toSearchParams,
} from '@/lib/view-state';
import { DEFAULT_WEIGHTS } from '@/domain/score';

/** SPEC §13.5 — view state lives in the URL, and a filter is presentation. */

describe('the weight vector is KEYED, not positional', () => {
  it('reads each weight from its own parameter', () => {
    const state = parseViewState(new URLSearchParams('w.compliance_risk=40&w.proximity=5'));
    expect(state.weights.compliance_risk).toBe(40);
    expect(state.weights.proximity).toBe(5);
  });

  it('fills a missing key from the Program default rather than shifting the vector', () => {
    // A positional vector silently misreads every saved link the moment a
    // Criterion is added or removed — and one WAS removed during design, when
    // data confidence became a badge.
    const state = parseViewState(new URLSearchParams('w.compliance_risk=40'));
    expect(state.weights.media_signal).toBe(DEFAULT_WEIGHTS.media_signal);
  });

  it('drops an unknown key rather than misreading the vector', () => {
    const state = parseViewState(new URLSearchParams('w.data_confidence=50&w.not_a_criterion=9'));
    expect(Object.keys(state.weights).sort()).toEqual([...Object.keys(DEFAULT_WEIGHTS)].sort());
  });

  it('drops an unparseable or negative weight', () => {
    const state = parseViewState(new URLSearchParams('w.proximity=abc&w.media_signal=-5'));
    expect(state.weights.proximity).toBe(DEFAULT_WEIGHTS.proximity);
    expect(state.weights.media_signal).toBe(DEFAULT_WEIGHTS.media_signal);
  });
});

describe('a link says what it means', () => {
  it('writes nothing when the rail is on the Program default', () => {
    // A URL with no w. parameters IS the Program's ranking.
    const state = parseViewState(new URLSearchParams(''));
    expect(toSearchParams(state).toString()).toBe('');
    expect(isWhatIf(state)).toBe(false);
  });

  it('writes only what differs', () => {
    const state = parseViewState(new URLSearchParams('w.compliance_risk=40'));
    expect(toSearchParams(state).toString()).toBe('w.compliance_risk=40');
    expect(isWhatIf(state)).toBe(true);
  });

  it('round-trips, so a shared what-if re-ranks identically for the recipient', () => {
    const original = parseViewState(new URLSearchParams('w.compliance_risk=40&country=DEU,JPN'));
    const round = parseViewState(toSearchParams(original));
    expect(round.weights).toEqual(original.weights);
    expect(round.facets.country).toEqual(['DEU', 'JPN']);
  });
});

describe('the five facets', () => {
  it('reads every documented facet', () => {
    const state = parseViewState(
      new URLSearchParams(
        'country=DEU&matchStatus=needs_review&riskFlag=forced_labor&scoreBand=high&ownershipGroup=forvia',
      ),
    );
    expect(state.facets.country).toEqual(['DEU']);
    expect(state.facets.matchStatus).toEqual(['needs_review']);
    expect(state.facets.riskFlag).toEqual(['forced_labor']);
    expect(state.facets.scoreBand).toEqual(['high']);
    expect(state.facets.ownershipGroup).toEqual(['forvia']);
    expect(hasFilter(state)).toBe(true);
  });

  it('treats a map region as a CAMERA, not a facet', () => {
    // It moves the viewport and must not remove suppliers from the table below.
    const state = parseViewState(new URLSearchParams('region=europe'));
    expect(state.mapRegion).toBe('europe');
    expect(hasFilter(state)).toBe(false);
  });

  it('records which chart drove the filter, so the crop can be explained', () => {
    expect(parseViewState(new URLSearchParams('country=DEU&from=country_chart')).filterSource).toBe(
      'country_chart',
    );
  });
});

describe('a discrete act pushes history; a continuous gesture replaces it', () => {
  it('replaces on a drag, so one slider cannot bury the spine', () => {
    expect(historyModeFor('drag')).toBe('replace');
  });

  it('pushes on a preset, a chat change, a navigation and a filter', () => {
    for (const gesture of ['preset', 'chat', 'navigate', 'filter'] as const) {
      expect(historyModeFor(gesture)).toBe('push');
    }
  });
});

import { describe, expect, it } from 'vitest';
import {
  computeStaleness,
  hashFrozenInputs,
  isViewingWhatIf,
  type CitableRow,
  type FrozenInputs,
} from '@/domain/staleness';

/**
 * SPEC §12. The properties worth testing are the two the design argues for:
 * the indicators are **disjoint by construction**, and a dismissal is a
 * **watermark rather than a boolean**.
 */

const T0 = new Date('2026-08-01T00:00:00Z');
const T1 = new Date('2026-08-15T00:00:00Z');
const T2 = new Date('2026-08-20T00:00:00Z');

const frozen = (overrides: Partial<FrozenInputs> = {}): FrozenInputs => ({
  weights: { compliance_risk: 28, proximity: 11 },
  criterionValues: { 'supplier-a:compliance_risk': 100 },
  scores: { 'supplier-a': 84.2 },
  shortlistOrder: ['supplier-a', 'supplier-b'],
  supplierVerdicts: { 'supplier-a': { verdict: 'recommend', evaluatorOutcome: 'passed' } },
  ...overrides,
});

const row = (subjectKey: string, kind: string, firstSeenAt: Date): CitableRow => ({
  subjectKey,
  kind,
  firstSeenAt,
  rowId: `${kind}-${subjectKey}-${firstSeenAt.toISOString()}`,
});

describe('inputs moved — the causal indicator', () => {
  it('is dark when nothing changed', () => {
    const s = computeStaleness({
      frozenAt: T0,
      frozen: frozen(),
      current: frozen(),
      candidateRows: [],
      citedSubjects: new Set(),
    });
    expect(s.inputsMoved.lit).toBe(false);
  });

  it('lights when a weight moved, and names the path', () => {
    const s = computeStaleness({
      frozenAt: T0,
      frozen: frozen(),
      current: frozen({ weights: { compliance_risk: 40, proximity: 11 } }),
      candidateRows: [],
      citedSubjects: new Set(),
    });
    expect(s.inputsMoved.lit).toBe(true);
    expect(s.inputsMoved.changes).toEqual([
      { path: 'weights.compliance_risk', from: 28, to: 40 },
    ]);
  });

  it('lights when the Shortlist order moved', () => {
    const s = computeStaleness({
      frozenAt: T0,
      frozen: frozen(),
      current: frozen({ shortlistOrder: ['supplier-b', 'supplier-a'] }),
      candidateRows: [],
      citedSubjects: new Set(),
    });
    expect(s.inputsMoved.lit).toBe(true);
  });

  it('lights when a Supplier’s VERDICT moved, though no number did', () => {
    // The sharpest consequence in §12: a Supplier re-assessed into
    // `do_not_shortlist` was invisible to both signals, because its verdict was
    // in no frozen input and a Recommendation may not cite an Assessment.
    // Widening frozen_inputs closes it inside the existing comparison.
    const s = computeStaleness({
      frozenAt: T0,
      frozen: frozen(),
      current: frozen({
        supplierVerdicts: {
          'supplier-a': { verdict: 'do_not_shortlist', evaluatorOutcome: 'passed' },
        },
      }),
      candidateRows: [],
      citedSubjects: new Set(),
    });
    expect(s.inputsMoved.lit).toBe(true);
    expect(s.inputsMoved.changes[0]!.path).toBe('verdicts.supplier-a.verdict');
  });
});

describe('new evidence — the residual', () => {
  it('lights for a row first seen after the version, about something it cites', () => {
    const s = computeStaleness({
      frozenAt: T0,
      frozen: frozen(),
      current: frozen(),
      candidateRows: [row('entity-x', 'family_member', T1)],
      citedSubjects: new Set(['entity-x']),
    });
    expect(s.newEvidence.lit).toBe(true);
    expect(s.newEvidence.byKind).toEqual({ family_member: 1 });
  });

  it('ignores a row the version does not cite', () => {
    const s = computeStaleness({
      frozenAt: T0,
      frozen: frozen(),
      current: frozen(),
      candidateRows: [row('entity-y', 'family_member', T1)],
      citedSubjects: new Set(['entity-x']),
    });
    expect(s.newEvidence.lit).toBe(false);
  });

  it('ignores a row that predates the version', () => {
    const s = computeStaleness({
      frozenAt: T1,
      frozen: frozen(),
      current: frozen(),
      candidateRows: [row('entity-x', 'enrichment', T0)],
      citedSubjects: new Set(['entity-x']),
    });
    expect(s.newEvidence.lit).toBe(false);
  });

  it('attaches BY SUBJECT, not by row id — a refreshed tariff is the same subject', () => {
    // A refreshed tariff writes a NEW enrichment row for the same HS line. A
    // rule keyed on row id would call that new evidence about nothing.
    const s = computeStaleness({
      frozenAt: T0,
      frozen: frozen(),
      current: frozen(),
      candidateRows: [row('hs:8544.30', 'enrichment', T1)],
      citedSubjects: new Set(['hs:8544.30']),
    });
    expect(s.newEvidence.lit).toBe(true);
  });

  it('names what arrived, because a dismissal without grounds is not a judgement', () => {
    const s = computeStaleness({
      frozenAt: T0,
      frozen: frozen(),
      current: frozen(),
      candidateRows: [
        row('entity-x', 'family_member', T1),
        row('entity-x', 'family_member', T2),
        row('entity-x', 'news_item', T1),
      ],
      citedSubjects: new Set(['entity-x']),
    });
    expect(s.newEvidence.byKind).toEqual({ family_member: 2, news_item: 1 });
    expect(s.newEvidence.rows).toHaveLength(3);
  });
});

describe('the two indicators are disjoint BY CONSTRUCTION, not by rule', () => {
  it('lights only the causal one when a change both moves a number and arrives as a row', () => {
    // Both a Criterion value moved for supplier-a AND a row arrived about
    // supplier-a. The banner explains it; the chip must stay dark, or a person
    // has to work out which of two lit indicators to believe.
    const s = computeStaleness({
      frozenAt: T0,
      frozen: frozen(),
      current: frozen({ criterionValues: { 'supplier-a:compliance_risk': 60 } }),
      candidateRows: [row('supplier-a:compliance_risk', 'criterion_value', T1)],
      citedSubjects: new Set(['supplier-a:compliance_risk']),
    });
    expect(s.inputsMoved.lit).toBe(true);
    expect(s.newEvidence.lit).toBe(false);
  });

  it('lights only new evidence for a Deep Traversal, which changes no number', () => {
    // This is the case the whole design turns on. Ownership exposure scores
    // current one-hop edges, so a hop-2 edge moves nothing in frozen_inputs —
    // and a staleness rule keyed on numbers would be blind to it.
    const s = computeStaleness({
      frozenAt: T0,
      frozen: frozen(),
      current: frozen(),
      candidateRows: [row('entity-x', 'family_member', T1)],
      citedSubjects: new Set(['entity-x']),
    });
    expect(s.inputsMoved.lit).toBe(false);
    expect(s.newEvidence.lit).toBe(true);
  });
});

describe('a dismissal is a watermark, not a boolean', () => {
  it('silences the evidence it saw', () => {
    const current = frozen();
    const s = computeStaleness({
      frozenAt: T0,
      frozen: frozen(),
      current,
      candidateRows: [row('entity-x', 'family_member', T1)],
      citedSubjects: new Set(['entity-x']),
      dismissal: { dismissedTo: T2, dismissedInputsHash: hashFrozenInputs(current) },
    });
    expect(s.newEvidence.lit).toBe(false);
  });

  it('RE-LIGHTS on a later, different row — it is never silently muted', () => {
    const current = frozen();
    const s = computeStaleness({
      frozenAt: T0,
      frozen: frozen(),
      current,
      candidateRows: [row('entity-x', 'family_member', T2)],
      citedSubjects: new Set(['entity-x']),
      dismissal: { dismissedTo: T1, dismissedInputsHash: hashFrozenInputs(current) },
    });
    expect(s.newEvidence.lit).toBe(true);
  });

  it('re-lights the banner on an inputs delta it was not dismissed against', () => {
    const dismissedAgainst = frozen();
    const movedAgain = frozen({ weights: { compliance_risk: 35, proximity: 11 } });
    const s = computeStaleness({
      frozenAt: T0,
      frozen: frozen(),
      current: movedAgain,
      candidateRows: [],
      citedSubjects: new Set(),
      dismissal: { dismissedTo: T2, dismissedInputsHash: hashFrozenInputs(dismissedAgainst) },
    });
    expect(s.inputsMoved.lit).toBe(true);
  });

  it('hashes stably regardless of key order', () => {
    const a: FrozenInputs = frozen({ weights: { compliance_risk: 28, proximity: 11 } });
    const b: FrozenInputs = frozen({ weights: { proximity: 11, compliance_risk: 28 } });
    expect(hashFrozenInputs(a)).toBe(hashFrozenInputs(b));
  });
});

describe('the what-if chip is not about a version at all', () => {
  it('compares the rail to the Program default only', () => {
    const def = { compliance_risk: 28, proximity: 11 };
    expect(isViewingWhatIf(def, def)).toBe(false);
    expect(isViewingWhatIf({ compliance_risk: 40, proximity: 11 }, def)).toBe(true);
  });
});

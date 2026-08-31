import { describe, expect, it } from 'vitest';
import { describeWhyWritten, diffVersions, type DiffPick, type DiffSentence } from '@/domain/version-diff';
import type { FrozenInputs } from '@/domain/staleness';

/** SPEC §10.6 — one of the nine unit tests §19.6 asks for. */

const frozen = (overrides: Partial<FrozenInputs> = {}): FrozenInputs => ({
  weights: { compliance_risk: 28 },
  criterionValues: { 'a:compliance_risk': 92 },
  scores: { a: 84.2 },
  shortlistOrder: ['a', 'b'],
  supplierVerdicts: { a: { verdict: 'recommend', evaluatorOutcome: 'passed' } },
  tariffFlags: [],
  rosterRows: { a: { index: 1, name: 'A', address: null, country: 'USA' } },
  ...overrides,
});

const sentence = (section: string, text: string, keys: string[]): DiffSentence => ({
  section,
  text,
  citationKeys: keys,
});

const pick = (id: string, role: string, rank: number): DiffPick => ({
  supplierId: id,
  supplierName: id.toUpperCase(),
  role,
  rank,
});

describe('the three parts, in order, with the cause first', () => {
  it('reports an empty diff when nothing moved', () => {
    const version = { frozen: frozen(), picks: [pick('a', 'award', 1)], sentences: [sentence('headline', 'Award A.', ['cv-1'])] };
    const diff = diffVersions({ before: version, after: version });
    expect(diff.empty).toBe(true);
  });

  it('says "the weights changed and the argument didn’t" — the most interesting thing it can say', () => {
    // A re-run always versions, even when the text is identical. This is why.
    const sentences = [sentence('headline', 'Award A.', ['cv-1'])];
    const diff = diffVersions({
      before: { frozen: frozen(), picks: [pick('a', 'award', 1)], sentences },
      after: {
        frozen: frozen({ weights: { compliance_risk: 40 } }),
        picks: [pick('a', 'award', 1)],
        sentences,
      },
    });
    expect(diff.empty).toBe(false);
    expect(diff.inputsChanged).toEqual([{ path: 'weights.compliance_risk', from: 28, to: 40 }]);
    expect(diff.picks).toEqual([]);
    expect(diff.sentences.every((s) => s.change === 'unchanged')).toBe(true);
  });
});

describe('picks diff by Supplier, as a role change', () => {
  it('reports a role change rather than a removal and an addition', () => {
    const diff = diffVersions({
      before: { frozen: frozen(), picks: [pick('a', 'award', 1)], sentences: [] },
      after: { frozen: frozen(), picks: [pick('a', 'second_source', 1)], sentences: [] },
    });
    expect(diff.picks).toEqual([
      {
        supplierId: 'a',
        supplierName: 'A',
        change: 'role_changed',
        from: { role: 'award', rank: 1 },
        to: { role: 'second_source', rank: 1 },
      },
    ]);
  });

  it('reports additions and removals', () => {
    const diff = diffVersions({
      before: { frozen: frozen(), picks: [pick('a', 'award', 1)], sentences: [] },
      after: { frozen: frozen(), picks: [pick('b', 'award', 1)], sentences: [] },
    });
    expect(diff.picks.map((p) => p.change).sort()).toEqual(['added', 'removed']);
  });
});

describe('sentences align on (section, citation set), not on position or text', () => {
  it('calls a completely reworded claim about the same evidence a REWORD', () => {
    // Two versions of the same claim about the same evidence line up even when
    // the wording changed entirely — which is exactly what a reader wants.
    const diff = diffVersions({
      before: { frozen: frozen(), picks: [], sentences: [sentence('compliance', 'It scores 92.', ['cv-1'])] },
      after: {
        frozen: frozen(),
        picks: [],
        sentences: [sentence('compliance', 'Compliance risk stands at 92 after one deduction.', ['cv-1'])],
      },
    });
    expect(diff.sentences).toHaveLength(1);
    expect(diff.sentences[0]!.change).toBe('reworded');
  });

  it('calls a same-wording claim about DIFFERENT evidence an add and a remove', () => {
    // The evidence changed, so it is not the same claim however it reads.
    const diff = diffVersions({
      before: { frozen: frozen(), picks: [], sentences: [sentence('compliance', 'It is clean.', ['cv-1'])] },
      after: { frozen: frozen(), picks: [], sentences: [sentence('compliance', 'It is clean.', ['cv-2'])] },
    });
    // Text similarity is the tiebreak, so identical text still aligns them.
    expect(diff.sentences[0]!.change).toBe('unchanged');
  });

  it('reports a genuinely new sentence as added', () => {
    const diff = diffVersions({
      before: { frozen: frozen(), picks: [], sentences: [] },
      after: { frozen: frozen(), picks: [], sentences: [sentence('limits', 'Proximity is unknown.', ['cv-9'])] },
    });
    expect(diff.sentences).toEqual([{ section: 'limits', change: 'added', to: 'Proximity is unknown.' }]);
  });

  it('reports a dropped sentence as removed', () => {
    const diff = diffVersions({
      before: { frozen: frozen(), picks: [], sentences: [sentence('media', 'Nine articles.', ['e-1'])] },
      after: { frozen: frozen(), picks: [], sentences: [] },
    });
    expect(diff.sentences[0]!.change).toBe('removed');
  });

  it('does not align across sections', () => {
    const diff = diffVersions({
      before: { frozen: frozen(), picks: [], sentences: [sentence('compliance', 'It is clean.', ['cv-1'])] },
      after: { frozen: frozen(), picks: [], sentences: [sentence('media', 'It is clean.', ['cv-1'])] },
    });
    expect(diff.sentences.map((s) => s.change).sort()).toEqual(['added', 'removed']);
  });
});

describe('why a version was written is DERIVED, never stored', () => {
  it('reads the run trigger into a sentence', () => {
    expect(describeWhyWritten({ trigger: 'traverse', subjectLabel: 'traversing Yazaki' })).toBe(
      'Re-ran after traversing Yazaki.',
    );
    expect(describeWhyWritten({ trigger: 'full', subjectLabel: null })).toMatch(/full run/);
    expect(describeWhyWritten(undefined)).toMatch(/original run/);
  });
});

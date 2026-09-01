import { describe, expect, it } from 'vitest';
import { supplierAnswer, type SupplierAnswerInput } from '@/domain/supplier-answer';

/**
 * **A page opens with what is happening and what to do.**
 *
 * The critique that produced this found the opposite on every manager-facing
 * surface: Bosch's page is 2,707 words, "score 30.1" arrives at word 30 with no
 * scale, and the verdict `escalate` at word 609 as a grey badge weighing exactly
 * as much as "assessed".
 *
 * What is worth testing here is not the wording but the **order the cases are
 * tested in**, because that order is the claim: an unsettled identity outranks
 * every finding underneath it, and an unresolved objection outranks the verdict
 * it was published alongside.
 */

const base: SupplierAnswerInput = {
  name: 'Bosch',
  match: { status: 'accepted', settledBy: 'rules', entityLabel: 'ROBERT BOSCH GMBH' },
  assessment: undefined,
  score: 30.1,
  scoreAbsentReason: undefined,
  disqualifying: false,
  needsReviewHref: '/program/p/needs-review',
  assessmentHref: '#assessment',
  compareHref: '/program/p/category/c',
  categoryName: 'Braking & steering',
};

const answer = (overrides: Partial<SupplierAnswerInput> = {}) =>
  supplierAnswer({ ...base, ...overrides });

describe('identity outranks everything below it', () => {
  /**
   * The rule the whole page rests on: a number about a company nobody has
   * identified is worse than no number. So an unsettled identity is the answer
   * even when there is a score and an assessment sitting underneath it.
   */
  it('says who has to decide, not what the score was', () => {
    const result = answer({
      match: { status: 'needs_review', settledBy: 'agents', entityLabel: null },
      score: 30.1,
      assessment: { verdict: 'recommend', evaluatorOutcome: 'passed', objections: [] },
    });
    expect(result.tone).toBe('you');
    expect(result.said).toBe('Bosch is waiting for you to say which company it is.');
    expect(result.actions[0]).toMatchObject({ href: '/program/p/needs-review', primary: true });
  });

  it('stops on a row nothing was found for', () => {
    const result = answer({ match: { status: 'not_found', settledBy: 'agents', entityLabel: null } });
    expect(result.tone).toBe('stop');
    expect(result.said).toMatch(/could not find Bosch on the graph/);
  });

  it('reports a row nothing has been run against as news, not as a problem', () => {
    const result = answer({ match: undefined, score: null });
    expect(result.tone).toBe('neutral');
    expect(result.actions).toEqual([]);
  });
});

describe('an unresolved objection outranks the verdict it was published with', () => {
  /**
   * The Bosch case, and the one the redesign exists for. `escalate` and
   * `published_with_objections` were two grey badges at word 609; whether
   * anybody has signed off is the first thing a manager needs.
   */
  it('leads with escalate when the reviewer never backed down', () => {
    const result = answer({
      assessment: {
        verdict: 'escalate',
        evaluatorOutcome: 'published_with_objections',
        objections: ['The compliance path cannot be inspected in this application.'],
      },
    });
    expect(result.tone).toBe('you');
    expect(result.said).toBe('Escalate — Bosch needs a person, and the write-up says why.');
    expect(result.because).toMatch(/an unresolved objection/);
    expect(result.actions[0]?.label).toBe('Read the objection');
  });

  /**
   * Denso's case: recommended, and published over an objection anyway. The
   * recommendation is not the headline while nobody has signed off.
   */
  it('does not read as a recommendation while an objection stands', () => {
    const result = answer({
      name: 'Denso',
      assessment: {
        verdict: 'recommend_with_conditions',
        evaluatorOutcome: 'published_with_objections',
        objections: ['a', 'b'],
      },
    });
    expect(result.said).toMatch(/^Escalate/);
    expect(result.because).toMatch(/2 unresolved objections/);
  });

  it('counts one objection as one', () => {
    const result = answer({
      assessment: { verdict: 'escalate', evaluatorOutcome: 'published_with_objections', objections: ['a'] },
    });
    expect(result.because).toMatch(/an unresolved objection:/);
  });
});

describe('a settled verdict reads as itself', () => {
  it('recommends without hedging when nothing objected', () => {
    const result = answer({
      assessment: { verdict: 'recommend', evaluatorOutcome: 'passed', objections: [] },
    });
    expect(result.tone).toBe('ok');
    expect(result.said).toBe('Bosch is worth taking forward.');
  });

  it('names the conditions as the point when there are conditions', () => {
    const result = answer({
      assessment: { verdict: 'recommend_with_conditions', evaluatorOutcome: 'passed', objections: [] },
    });
    expect(result.tone).toBe('ok');
    expect(result.said).toMatch(/with conditions/);
    expect(result.actions[0]?.label).toBe('Read the conditions');
  });

  /**
   * A disqualifying factor is a different claim from a low score, and saying so
   * is the difference between *this one is ruled out* and *this one ranked
   * badly*. Both are `do_not_shortlist`.
   */
  it('distinguishes ruled out from ranked badly', () => {
    const ruledOut = answer({
      assessment: { verdict: 'do_not_shortlist', evaluatorOutcome: 'passed', objections: [] },
      disqualifying: true,
    });
    const rankedBadly = answer({
      assessment: { verdict: 'do_not_shortlist', evaluatorOutcome: 'passed', objections: [] },
      disqualifying: false,
    });
    expect(ruledOut.tone).toBe('stop');
    expect(ruledOut.because).toMatch(/rules this supplier out on its own/);
    expect(rankedBadly.because).toMatch(/stays on the roster and keeps its score/);
  });

  it('offers the comparison the verdict should be read against', () => {
    const result = answer({
      assessment: { verdict: 'recommend', evaluatorOutcome: 'passed', objections: [] },
    });
    expect(result.actions.at(-1)).toMatchObject({
      label: 'Compare against the rest of Braking & steering',
      href: '/program/p/category/c',
    });
  });

  it('leaves the comparison out for a supplier on no category', () => {
    const result = answer({
      assessment: { verdict: 'recommend', evaluatorOutcome: 'passed', objections: [] },
      compareHref: null,
      categoryName: null,
    });
    expect(result.actions.map((a) => a.label)).toEqual(['Read the reasoning']);
  });
});

describe('what is missing, said as what is missing', () => {
  /**
   * Three reasons a score is absent, and they are not the same news. The third
   * used to render as "its match is not settled" directly beneath a heading
   * reading "accepted" — which told the reader the one thing on the page that
   * was false.
   */
  it('separates "bids on nothing" from "nothing fetched yet"', () => {
    const noCategory = answer({ score: null, scoreAbsentReason: 'no_category' });
    const noValues = answer({ score: null, scoreAbsentReason: 'no_values' });

    expect(noCategory.said).toMatch(/is mapped to no category in this programme/);
    expect(noValues.said).toMatch(/have not looked it up yet/);
    expect(noValues.actions[0]).toMatchObject({ action: 'enrich', primary: true });
  });

  it('says the write-up is the missing step when the figures are there', () => {
    const result = answer({ score: 30.1, assessment: undefined });
    expect(result.said).toBe('Bosch has been measured and not yet written up.');
    expect(result.because).toMatch(/ROBERT BOSCH GMBH/);
    expect(result.actions[0]).toMatchObject({ action: 'assess', primary: true });
  });

  /** A published version with no verdict falls through rather than asserting one. */
  it('falls through a version that reached no verdict', () => {
    const result = answer({
      assessment: { verdict: null, evaluatorOutcome: 'passed', objections: [] },
    });
    expect(result.said).toBe('Bosch has been measured and not yet written up.');
  });
});

describe('every answer is one a person could act on', () => {
  const cases: SupplierAnswerInput[] = [
    base,
    { ...base, match: undefined, score: null },
    { ...base, match: { status: 'not_found', settledBy: 'agents', entityLabel: null } },
    { ...base, match: { status: 'needs_review', settledBy: 'agents', entityLabel: null } },
    { ...base, score: null, scoreAbsentReason: 'no_category' },
    { ...base, score: null, scoreAbsentReason: 'no_values' },
    ...(['recommend', 'recommend_with_conditions', 'do_not_shortlist', 'escalate'] as const).map(
      (verdict) => ({
        ...base,
        assessment: { verdict, evaluatorOutcome: 'passed' as const, objections: [] },
      }),
    ),
  ];

  it('never answers with a bare status word', () => {
    for (const input of cases) {
      const result = supplierAnswer(input);
      // A sentence, not a label: it ends in a full stop and names the supplier
      // or says plainly what is absent.
      expect(result.said.length).toBeGreaterThan(20);
      expect(result.said).toMatch(/[.!]$/);
      expect(result.because.length).toBeGreaterThan(40);
    }
  });

  it('gives at most one primary action, because two is no priority at all', () => {
    for (const input of cases) {
      const result = supplierAnswer(input);
      expect(result.actions.filter((a) => a.primary).length).toBeLessThanOrEqual(1);
    }
  });
});

import { describe, expect, it } from 'vitest';
import { proposerSystem } from '@/model/prompts/assess';
import { leadSystem } from '@/model/prompts/recommend';
import { WEIGHTED_CRITERIA } from '@/domain/score';
import {
  checkAssessment,
  type ResolvedEvidence,
  type SubmittedSentence,
} from '@/domain/validation/submit-checks';

/**
 * **The prompt asks for the words the check accepts** (finding 152).
 *
 * `checkLimitsNamesUnknowns` reads the limits section for a Criterion's key or
 * that key with its underscores as spaces. The prompt did not say so, and the
 * outcome rode on the model's wording: Valeo's Assessment was refused three
 * Rounds running for writing *"the tariff criterion returned unknown"* where
 * the check wanted *"tariff exposure"*, while Bosch failed the same way once
 * and passed on a second recording.
 *
 * So this file asserts the two halves against each other rather than the prompt
 * against a copy of itself: every word the prompt offers is a word the check
 * takes, and every Criterion the Score weighs is a word the prompt offers.
 */

const cited = (section: string, text: string): SubmittedSentence => ({
  section,
  text,
  citations: [{ criterionValueId: 'cv-1' }],
});

function evidence(unknownCriteria: string[]): ResolvedEvidence {
  return {
    rowsByCitation: new Map([[JSON.stringify({ criterionValueId: 'cv-1' }), { value: 92 }]]),
    frozenInputs: {},
    suppliers: new Map([
      [
        'supplier-a',
        {
          name: 'Alpha',
          matchAccepted: true,
          entityId: 'entity-alpha',
          categoryIds: ['cat-1'],
          categoriesWithScore: ['cat-1'],
          disqualifying: false,
          publishedWithObjections: false,
          onShortlist: true,
        },
      ],
    ]),
    unknownCriteria,
    mandatoryCaveats: [],
  };
}

describe('the assess proposer prompt names the six weighted criteria', () => {
  it.each(WEIGHTED_CRITERIA)('offers "%s" in the words the check accepts', (key) => {
    const words = key.replace(/_/g, ' ');
    const unwrapped = proposerSystem.replace(/\s+/g, ' ');
    expect(unwrapped, `the limits instruction never says "${words}"`).toContain(words);
  });

  it.each(WEIGHTED_CRITERIA)('and the check accepts those words for "%s"', (key) => {
    const words = key.replace(/_/g, ' ');
    const objections = checkAssessment({
      verdict: 'recommend',
      supplierId: 'supplier-a',
      sentences: [
        cited('identity', 'Alpha is the company.'),
        cited('limits', `The ${words} criterion returned unknown.`),
      ],
      evidence: evidence([key]),
    });
    expect(objections, `the prompt's own words do not satisfy the check for ${key}`).toEqual([]);
  });

  it('tells the writer that a paraphrase does not carry the name', () => {
    expect(proposerSystem.replace(/\s+/g, ' ')).toMatch(/not with a paraphrase/);
  });
});

/**
 * The other half of finding 152: the objection said *"write the figure as it is
 * stored"*, so the model copied stored floats whole. Both proposers now say
 * what the check has always accepted.
 */
describe('both proposer prompts say how to write a stored figure', () => {
  it.each([
    ['assess', proposerSystem],
    ['recommend', leadSystem],
  ])('%s', (_name, prompt) => {
    // The prompts are hard-wrapped, so the sentence is matched unwrapped.
    const unwrapped = prompt.replace(/\s+/g, ' ');
    expect(unwrapped).toMatch(/rounded to one decimal unless the stored value has fewer/);
    expect(unwrapped).toMatch(/rounds to the decimals you wrote/);
  });
});

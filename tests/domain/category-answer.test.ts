import { describe, expect, it } from 'vitest';
import { categoryAnswer, type CategoryAnswerInput } from '@/domain/category-answer';

/**
 * **The Category page is the page the product exists to produce**, and it
 * rendered "Actions", "Tariff" and "Weights" — three pieces of apparatus —
 * before the Shortlist.
 *
 * A Category's answer is **two things**, because they can be true at once and
 * are not the same news: who leads and whether that lead means anything, and
 * whether anybody has argued a case for awarding to them. A ranking is not a
 * decision, and a page showing a confident order with nothing behind it invites
 * being read as one.
 */

const row = (displayName: string, score: number | null, computed = 5, disqualifying = false) => ({
  supplierId: displayName.toLowerCase(),
  displayName,
  score,
  coverage: { computed, total: 6 },
  disqualifying,
});

const base: CategoryAnswerInput = {
  categoryName: 'Battery enclosures',
  ranked: [row('Flex-N-Gate', 80.7, 4), row('Benteler', 79.7, 4), row('Magna', 71.4, 5)],
  excluded: [],
  recommendation: undefined,
  recommendationHref: '/program/p/category/c/recommendation',
  compareHref: '/program/p/category/c?compare=1',
  supplierHref: (id) => `/program/p/supplier/${id}`,
};

const answers = (overrides: Partial<CategoryAnswerInput> = {}) =>
  categoryAnswer({ ...base, ...overrides });

describe('who leads, and whether that means anything', () => {
  /**
   * The measured case: 80.7 against 79.7. A single point is inside what moving
   * a weight does, and the weight rail is on the same screen — so calling it a
   * settled first place would be the page overstating its own evidence.
   */
  it('refuses to call a one-point lead a settled first place', () => {
    const [lead] = answers();
    expect(lead!.tone).toBe('you');
    expect(lead!.said).toBe(
      'Flex-N-Gate leads Battery enclosures — but by 1.0, which is not a settled first place.',
    );
    expect(lead!.because).toMatch(/inside what changes when you move a weight/);
    expect(lead!.actions[0]).toMatchObject({
      label: 'Compare the top two side by side',
      primary: true,
    });
  });

  it('calls a wide lead what it is', () => {
    const [lead] = answers({ ranked: [row('Flex-N-Gate', 80.7), row('Benteler', 60.2)] });
    expect(lead!.tone).toBe('ok');
    expect(lead!.said).toBe('Flex-N-Gate leads Battery enclosures, comfortably.');
    expect(lead!.because).toMatch(/no single weight on this page will close/);
  });

  /**
   * **The gap that matters is often not the score.** A leader ahead on points
   * and behind on how much has been measured is a different situation from a
   * leader ahead on both, and the scores alone never show it.
   */
  it('says when the leader rests on less evidence than the runner-up', () => {
    const [lead] = answers({
      ranked: [row('Flex-N-Gate', 80.7, 3), row('Benteler', 79.7, 6)],
    });
    expect(lead!.because).toMatch(
      /the leader rests on less: 3 of 6 criteria .* against Benteler's 6/,
    );
    expect(lead!.because).toMatch(/A higher score over fewer measurements is not the same claim/);
  });

  it('says when the comparison is like for like', () => {
    const [lead] = answers({ ranked: [row('A', 80.7, 5), row('B', 79.7, 5)] });
    expect(lead!.because).toMatch(/Both rest on the same 5 of 6 criteria/);
  });

  /**
   * A disqualifying factor is a different kind of fact from a low number: the
   * score says how well it fits, this says whether it can be considered at all.
   * Topping the ranking does not soften it.
   */
  it('leads with the disqualification even when the disqualified supplier is first', () => {
    const [lead] = answers({
      ranked: [row('Flex-N-Gate', 80.7, 5, true), row('Benteler', 79.7)],
    });
    expect(lead!.tone).toBe('stop');
    expect(lead!.said).toMatch(/carries something that rules it out/);
  });

  it('does not dress a shortlist of one as a comparison', () => {
    const [lead] = answers({ ranked: [row('Flex-N-Gate', 80.7)] });
    expect(lead!.tone).toBe('ok');
    expect(lead!.said).toMatch(/the only supplier with a score/);
    expect(lead!.because).toMatch(/first by default rather than by comparison/);
  });
});

describe('nothing to rank is two different pieces of news', () => {
  it('separates "nobody bids" from "nobody has a score"', () => {
    const nobodyBids = answers({ ranked: [], excluded: [] });
    const nobodyScored = answers({
      ranked: [row('A', null), row('B', null)],
      excluded: [{ reason: 'no_match' }, { reason: 'no_match' }],
    });

    expect(nobodyBids[0]!.because).toMatch(/No supplier bids on this category/);
    expect(nobodyScored[0]!.because).toMatch(
      /2 suppliers bid on this category and none of them has a score/,
    );
  });

  /** With nothing to recommend from, the second answer would be noise. */
  it('does not ask for a recommendation there is nothing to write', () => {
    expect(answers({ ranked: [] })).toHaveLength(1);
    expect(answers({ ranked: [row('A', null)] })).toHaveLength(1);
  });
});

describe('a ranking is not a decision', () => {
  it('says plainly when nobody has argued a case', () => {
    const [, recommendation] = answers();
    expect(recommendation!.tone).toBe('stop');
    expect(recommendation!.said).toBe('Nobody has written a recommendation for this category.');
    expect(recommendation!.because).toMatch(/a ranking is not a decision/);
    expect(recommendation!.actions[0]).toMatchObject({ action: 'recommend', primary: true });
  });

  it('does not read as settled when the recommendation published over an objection', () => {
    const [, recommendation] = answers({
      recommendation: { versionN: 1, evaluatorOutcome: 'published_with_objections' },
    });
    expect(recommendation!.tone).toBe('you');
    expect(recommendation!.because).toMatch(/Nobody has signed off on it/);
  });

  it('reads as settled when a second read agreed', () => {
    const [, recommendation] = answers({
      recommendation: { versionN: 2, evaluatorOutcome: 'passed' },
    });
    expect(recommendation!.tone).toBe('ok');
    expect(recommendation!.said).toMatch(/a second read agreed with it/);
  });
});

describe('every answer is one a person could act on', () => {
  const cases: CategoryAnswerInput[] = [
    base,
    { ...base, ranked: [] },
    { ...base, ranked: [row('A', null)], excluded: [{ reason: 'no_category' }] },
    { ...base, ranked: [row('A', 80.7, 5, true), row('B', 70)] },
    { ...base, recommendation: { versionN: 1, evaluatorOutcome: 'passed' } },
    { ...base, recommendation: { versionN: 1, evaluatorOutcome: 'published_with_objections' } },
    { ...base, compareHref: null },
  ];

  it('never answers with a bare status word, and never with two priorities', () => {
    for (const input of cases) {
      for (const answer of categoryAnswer(input)) {
        expect(answer.said.length).toBeGreaterThan(20);
        expect(answer.said).toMatch(/[.!]$/);
        expect(answer.because.length).toBeGreaterThan(40);
        expect(answer.actions.filter((a) => a.primary).length).toBeLessThanOrEqual(1);
      }
    }
  });

  it('offers at most two answers, and at least one', () => {
    for (const input of cases) {
      const result = categoryAnswer(input);
      expect(result.length).toBeGreaterThanOrEqual(1);
      expect(result.length).toBeLessThanOrEqual(2);
    }
  });
});

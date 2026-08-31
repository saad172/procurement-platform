import { describe, expect, it } from 'vitest';
import { programmeAnswer, type ProgrammeAnswerInput } from '@/domain/programme-answer';

/**
 * The Programme page opened with a two-figure strip, a run panel and four
 * charts under the heading *"Where this roster is, and whether resolution
 * worked"* — which names a **pipeline stage**, not a question anybody arrives
 * with.
 *
 * What is tested here is the order things block on: nothing listening beats
 * something waiting on a person beats where the programme is, and the last of
 * those only appears when neither of the first two does.
 */

const base: ProgrammeAnswerInput = {
  workerUp: true,
  running: undefined,
  suppliers: { total: 50, identified: 48, assessed: 3, uncategorised: 8 },
  waitingOnYou: { count: 0, names: [] },
  categories: { total: 8, withRecommendation: 0 },
  needsReviewHref: '/program/p/needs-review',
  runsHref: '/program/p/runs',
};

const answers = (overrides: Partial<ProgrammeAnswerInput> = {}) =>
  programmeAnswer({ ...base, ...overrides });

describe('nothing listening blocks everything under it', () => {
  /**
   * A liveness question, not a health one: a Job queued with no worker running
   * sits in `queued` for ever, and every button on the page will still accept
   * a click. Saying so first is the only useful thing the page can do.
   */
  it('leads with the worker being down, above anything waiting on a person', () => {
    const [first] = answers({
      workerUp: false,
      waitingOnYou: { count: 2, names: ['Nemak', 'NSK'] },
    });
    expect(first!.tone).toBe('stop');
    expect(first!.said).toBe('Nothing is running, so nothing is moving.');
    expect(first!.because).toMatch(/queue the work behind a machine that is not listening/);
  });

  it('still says what is waiting on a person, underneath it', () => {
    const result = answers({ workerUp: false, waitingOnYou: { count: 2, names: ['Nemak', 'NSK'] } });
    expect(result).toHaveLength(2);
    expect(result[1]!.tone).toBe('you');
  });

  /** A run in flight is news, but it is not a blockage. */
  it('reports a run in flight instead when the worker is up', () => {
    const [first] = answers({
      running: { jobsInFlight: 3, queued: 12, href: '/program/p/runs/r', label: 'The roster run' },
    });
    expect(first!.said).toBe('The roster run is running.');
    expect(first!.because).toMatch(/3 jobs in flight and 12 queued/);
  });

  it('counts one job as one job', () => {
    const [first] = answers({
      running: { jobsInFlight: 1, queued: 0, href: '/r', label: 'A run' },
    });
    expect(first!.because).toMatch(/^1 job in flight/);
  });
});

describe('what only a person can settle', () => {
  it('names the rows rather than counting them', () => {
    const [first] = answers({ waitingOnYou: { count: 2, names: ['Nemak', 'NSK'] } });
    expect(first!.said).toBe('2 suppliers are waiting on a decision only you can make.');
    expect(first!.because).toMatch(/For Nemak and NSK we found several companies/);
    expect(first!.actions[0]).toMatchObject({ label: 'Decide these 2', primary: true });
  });

  it('stops naming after three and says how many more', () => {
    const [first] = answers({
      waitingOnYou: { count: 5, names: ['A', 'B', 'C', 'D', 'E'] },
    });
    expect(first!.because).toMatch(/For A, B and C and 2 more/);
  });

  it('reads as one when there is one', () => {
    const [first] = answers({ waitingOnYou: { count: 1, names: ['Nemak'] } });
    expect(first!.said).toBe('One supplier is waiting on a decision only you can make.');
    expect(first!.actions[0]?.label).toBe('Decide it');
  });

  /**
   * The distinction the sentence has to carry: this is the software declining
   * to guess, not the software failing. A page that read as an error would
   * invite waiting for a fix that is never coming.
   */
  it('says why nobody else will resolve it', () => {
    const [first] = answers({ waitingOnYou: { count: 1, names: ['Nemak'] } });
    expect(first!.because).toMatch(/declining to guess rather than failing/);
  });
});

describe('where the programme actually is', () => {
  /**
   * **A category becomes awardable once a recommendation is written for it**,
   * so that is the figure this leads with — not the supplier count, which moves
   * early and steadily and reads like progress towards a decision it is not
   * progress towards.
   */
  it('says "at the beginning" when that is the honest read', () => {
    const [only] = answers();
    expect(answers()).toHaveLength(1);
    expect(only!.said).toBe('No category can be awarded yet, and 3 of 50 suppliers have been.');
    expect(only!.because).toMatch(/at the beginning rather than near a decision/);
  });

  it('does not say "written up" when nothing has been', () => {
    const [only] = answers({ suppliers: { ...base.suppliers, assessed: 0 } });
    expect(only!.said).toBe('No category can be awarded yet, and nothing has been written up.');
  });

  it('counts categories with an argued case behind them', () => {
    const [only] = answers({ categories: { total: 8, withRecommendation: 3 } });
    expect(only!.said).toBe('3 of 8 categories have an argued case behind them.');
    expect(only!.because).toMatch(/a ranking is not a decision/);
  });

  it('reads as done only when every category has one', () => {
    const [only] = answers({ categories: { total: 8, withRecommendation: 8 } });
    expect(only!.tone).toBe('ok');
    expect(only!.said).toBe('Every category has a recommendation behind it.');
  });

  /** Progress is the fallback, not an extra: it appears only when nothing blocks. */
  it('is left out entirely when something is blocking or waiting', () => {
    expect(answers({ workerUp: false })).toHaveLength(1);
    expect(answers({ waitingOnYou: { count: 1, names: ['Nemak'] } })).toHaveLength(1);
  });
});

describe('every answer is one a person could act on', () => {
  const cases: ProgrammeAnswerInput[] = [
    base,
    { ...base, workerUp: false },
    { ...base, waitingOnYou: { count: 2, names: ['Nemak', 'NSK'] } },
    { ...base, running: { jobsInFlight: 2, queued: 4, href: '/r', label: 'A run' } },
    { ...base, categories: { total: 8, withRecommendation: 8 } },
  ];

  it('never answers with a bare status word, and never with two priorities', () => {
    for (const input of cases) {
      for (const answer of programmeAnswer(input)) {
        // A sentence, not a label: several words, ending in a full stop.
        expect(answer.said.split(/\s+/).length).toBeGreaterThanOrEqual(4);
        expect(answer.said).toMatch(/[.!]$/);
        expect(answer.because.length).toBeGreaterThan(40);
        expect(answer.actions.filter((a) => a.primary).length).toBeLessThanOrEqual(1);
      }
    }
  });
});

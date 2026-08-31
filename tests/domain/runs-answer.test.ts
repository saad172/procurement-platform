import { describe, expect, it } from 'vitest';
import { runsAnswer, type RunsAnswerInput } from '@/domain/runs-answer';

/**
 * The page was headed **"Runs"** and opened with two efficiency cards and a
 * ledger — accurate, and answering a question nobody asked.
 *
 * *Why do only three of fifty suppliers have a write-up?* is answerable from
 * this page's own data and was nowhere on it: one batch of 47 was cancelled
 * with 43 jobs never started, and those 43 sat in a column four scrolls down.
 */

const base: RunsAnswerInput = {
  runs: [
    {
      id: 'r1',
      label: 'assess 47 supplier(s)',
      state: 'cancelled',
      jobs: { total: 47, done: 2, failed: 2, neverStarted: 43 },
      actualUsd: 17.74,
    },
    {
      id: 'r2',
      label: 'enrich 48 supplier(s)',
      state: 'failed',
      jobs: { total: 48, done: 47, failed: 1, neverStarted: 0 },
      actualUsd: 22.1,
    },
  ],
  refusedByOurChecks: [
    { subjectLabel: 'Denso', runId: 'r1' },
    { subjectLabel: 'ZF Friedrichshafen', runId: 'r1' },
  ],
  totalUsd: 58.39,
  runHref: (id) => `/program/p/runs/${id}`,
};

const answers = (overrides: Partial<RunsAnswerInput> = {}) =>
  runsAnswer({ ...base, ...overrides });

describe('work that was started and never finished', () => {
  /** The real case, and the whole explanation for a nearly-empty programme. */
  it('names the abandoned batch and what it left undone', () => {
    const [first] = answers();
    expect(first!.tone).toBe('stop');
    expect(first!.said).toBe('Assess 47 supplier(s) was stopped part way. 43 of 47 never started.');
    expect(first!.because).toMatch(/2 finished, 2 were refused, and the remaining 43 never began/);
    expect(first!.because).toMatch(/after \$17\.74 had been spent/);
  });

  /**
   * Largest by what was left undone, not by what it cost: the question this
   * answers is why the programme is emptier than the work suggests, and that
   * is a count of things that never ran.
   */
  it('picks the batch that left the most undone, not the dearest', () => {
    const [first] = answers({
      runs: [
        { id: 'cheap', label: 'a big batch', state: 'cancelled', jobs: { total: 90, done: 0, failed: 0, neverStarted: 90 }, actualUsd: 0.1 },
        { id: 'dear', label: 'a small batch', state: 'cancelled', jobs: { total: 5, done: 0, failed: 0, neverStarted: 5 }, actualUsd: 300 },
      ],
    });
    expect(first!.said).toMatch(/^A big batch was stopped part way\. 90 of 90 never started\./);
  });

  it('does not claim anything finished when nothing did', () => {
    const [first] = answers({
      runs: [{ id: 'r', label: 'a batch', state: 'cancelled', jobs: { total: 10, done: 0, failed: 0, neverStarted: 10 }, actualUsd: 0 }],
    });
    expect(first!.because).toMatch(/^None finished, and the remaining 10/);
  });
});

describe('our own checks refusing to publish', () => {
  /**
   * The distinction the sentence exists to carry. A validator refusing an
   * unverifiable number reads as a failure on a ledger, and it is the opposite
   * — but nobody was told at the time.
   */
  it('says it is the system working, and names who it happened to', () => {
    const [, second] = answers();
    expect(second!.tone).toBe('you');
    expect(second!.said).toBe(
      '2 write-ups were refused by our own checks — and that is the system working.',
    );
    expect(second!.because).toMatch(/For Denso and ZF Friedrichshafen the check could not find the figure/);
    expect(second!.because).toMatch(/Nothing was lost except the attempt/);
  });

  it('reads as one when there is one', () => {
    const [, second] = answers({ refusedByOurChecks: [{ subjectLabel: 'Denso', runId: 'r1' }] });
    expect(second!.said).toMatch(/^One write-up was refused/);
  });

  it('stops naming after three', () => {
    const [, second] = answers({
      refusedByOurChecks: ['A', 'B', 'C', 'D'].map((n) => ({ subjectLabel: n, runId: 'r1' })),
    });
    expect(second!.because).toMatch(/For A, B and C and 1 more/);
  });
});

describe('when there is nothing to flag', () => {
  const clean: RunsAnswerInput = {
    ...base,
    runs: [{ id: 'r', label: 'a batch', state: 'done', jobs: { total: 5, done: 5, failed: 0, neverStarted: 0 }, actualUsd: 3 }],
    refusedByOurChecks: [],
  };

  it('says so once, rather than saying nothing', () => {
    const result = runsAnswer(clean);
    expect(result).toHaveLength(1);
    expect(result[0]!.tone).toBe('ok');
    expect(result[0]!.said).toBe('Everything that was started has finished, at $58.39.');
    // The reason there is no filter bar, said where a reader would wonder.
    expect(result[0]!.because).toMatch(/no denominator to disclose/);
  });

  it('separates "nothing has run" from "everything finished"', () => {
    const result = runsAnswer({ ...clean, runs: [] });
    expect(result[0]!.tone).toBe('neutral');
    expect(result[0]!.said).toBe('Nothing has been run for this programme yet.');
  });
});

describe('every answer is one a person could act on', () => {
  const cases: RunsAnswerInput[] = [
    base,
    { ...base, refusedByOurChecks: [] },
    { ...base, runs: [], refusedByOurChecks: [] },
    { ...base, runs: base.runs.map((r) => ({ ...r, jobs: { ...r.jobs, neverStarted: 0 } })), refusedByOurChecks: [] },
  ];

  it('never answers with a bare status word, and never with two priorities', () => {
    for (const input of cases) {
      for (const answer of runsAnswer(input)) {
        expect(answer.said.split(/\s+/).length).toBeGreaterThanOrEqual(4);
        expect(answer.said).toMatch(/[.!]$/);
        expect(answer.because.length).toBeGreaterThan(40);
        expect(answer.actions.filter((a) => a.primary).length).toBeLessThanOrEqual(1);
      }
    }
  });
});

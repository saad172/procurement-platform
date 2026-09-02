import { describe, expect, it } from 'vitest';
import { runProposerEvaluatorLoop, type ProposalResult } from '@/jobs/rounds';
import { MAX_FREE_RETRIES_PER_ROUND, MAX_ROUNDS } from '@/config/constants';

/**
 * SPEC §10.5 and §19.3.
 *
 * §19.3 names this test explicitly: a result the model's output controls is
 * *"tested without a fixture — a loop-driver unit test with a hand-written
 * fake, proving retries free, capped at 2, counter does not advance."*
 *
 * A fake rather than a fixture, because a fixture records what one model
 * happened to do, and what is under test is what the LOOP does about it.
 */

type Draft = { id: string };

const draft = (id: string): ProposalResult<Draft> => ({
  kind: 'draft',
  draft: { id },
  text: `draft ${id}`,
});
const refinementFailure = (message: string): ProposalResult<Draft> => ({
  kind: 'refinement_failure',
  message,
});

describe('a refinement failure retries FREE, and the counter does not advance', () => {
  it('retries and still converges inside round 1', async () => {
    const proposals: ProposalResult<Draft>[] = [
      refinementFailure('missing required field'),
      refinementFailure('missing required field'),
      draft('a'),
    ];
    let calls = 0;
    const outcome = await runProposerEvaluatorLoop<Draft>({
      propose: async () => proposals[calls++]!,
      validate: async () => [],
      evaluate: async () => ({ kind: 'pass', rubric: {}, text: 'ok' }),
    });

    expect(outcome.evaluatorOutcome).toBe('passed');
    // THE COUNTER DID NOT ADVANCE: two free retries, still round 1.
    expect(outcome.roundsUsed).toBe(1);
    expect(calls).toBe(3);
  });

  it('is capped at two free retries per round', async () => {
    let calls = 0;
    const outcome = await runProposerEvaluatorLoop<Draft>({
      propose: async () => {
        calls += 1;
        return refinementFailure('still malformed');
      },
      validate: async () => [],
      evaluate: async () => ({ kind: 'pass', rubric: {}, text: 'ok' }),
    });

    expect(calls).toBe(MAX_FREE_RETRIES_PER_ROUND + 1);
    expect(outcome.evaluatorOutcome).toBe('published_with_objections');
    expect(outcome.dissent[0]!.objection).toMatch(/could not produce a well-shaped draft/);
  });

  it('records each free retry as a round row, so the trace shows what happened', async () => {
    let calls = 0;
    const outcome = await runProposerEvaluatorLoop<Draft>({
      propose: async () => (calls++ === 0 ? refinementFailure('bad shape') : draft('a')),
      validate: async () => [],
      evaluate: async () => ({ kind: 'pass', rubric: {}, text: 'ok' }),
    });
    // `attempt N of 3`, not `free retry N of 2` — the first try is not a retry,
    // and the old wording printed "free retry 3/2" (finding 72).
    const retries = outcome.rounds.filter((r) => r.objection?.includes('attempt'));
    expect(retries).toHaveLength(1);
  });
});

describe('a validator failure COSTS a round', () => {
  it('advances the counter and records source=code', async () => {
    // The distinction from a refinement failure is not bookkeeping: this is a
    // substantive disagreement about evidence, which is what a Round is for.
    let round = 0;
    const outcome = await runProposerEvaluatorLoop<Draft>({
      propose: async () => draft(`round-${++round}`),
      validate: async (d) =>
        d.id === 'round-1' ? [{ check: 'citations', message: 'a citation dangles' }] : [],
      evaluate: async () => ({ kind: 'pass', rubric: {}, text: 'ok' }),
    });

    expect(outcome.evaluatorOutcome).toBe('passed');
    expect(outcome.roundsUsed).toBe(2);
    const codeRejection = outcome.rounds.find((r) => r.role === 'evaluator' && r.source === 'code');
    expect(codeRejection).toBeDefined();
    expect(codeRejection!.objection).toMatch(/\[citations\] a citation dangles/);
  });

  it('carries the objection into the next proposal', async () => {
    const seen: string[][] = [];
    let round = 0;
    await runProposerEvaluatorLoop<Draft>({
      propose: async ({ objections }) => {
        seen.push(objections);
        return draft(`round-${++round}`);
      },
      validate: async (d) =>
        d.id === 'round-1' ? [{ check: 'caveats', message: 'the tariff caveat is missing' }] : [],
      evaluate: async () => ({ kind: 'pass', rubric: {}, text: 'ok' }),
    });
    expect(seen[0]).toEqual([]);
    expect(seen[1]).toEqual(['the tariff caveat is missing']);
  });

  it('never reaches the evaluator when the code checks reject', async () => {
    // The payload arrives before the insert, and the model is not asked to
    // review something the code has already refused.
    let evaluated = 0;
    await runProposerEvaluatorLoop<Draft>({
      propose: async () => draft('a'),
      validate: async () => [{ check: 'citations', message: 'dangling' }],
      evaluate: async () => {
        evaluated += 1;
        return { kind: 'pass', rubric: {}, text: 'ok' };
      },
    });
    expect(evaluated).toBe(0);
  });
});

describe('a draft the code rejected is never the fallback', () => {
  it('ends rejected_by_code when the attempts run out on a Round after a code rejection', async () => {
    /**
     * The exact sequence, which the `MAX_ROUNDS` guard does not cover:
     * Round 1's draft fails the code checks, and Round 2's three attempts all
     * fail to produce a draft at all. `state.lastDraft` still held Round 1's
     * rejected draft — cleared only when a draft passes — so the early return
     * published it, three Rounds before the insert would have refused it.
     */
    let round = 0;
    const outcome = await runProposerEvaluatorLoop<Draft>({
      propose: async () => {
        round += 1;
        return round === 1 ? draft('rejected-in-round-1') : refinementFailure('no draft at all');
      },
      validate: async () => [
        { check: 'citations', message: 'points at a row that does not exist' },
      ],
      evaluate: async () => {
        throw new Error('the evaluator must not run on a draft the code rejected');
      },
    });

    expect(outcome.evaluatorOutcome).toBe('rejected_by_code');
    expect(outcome.draft, 'the withheld draft is the whole point').toBeUndefined();
    // Both halves of the answer: what the code refused, and why no newer draft.
    const said = outcome.dissent.map((d) => d.objection).join(' ');
    expect(said).toContain('points at a row that does not exist');
    expect(said).toContain('well-shaped');
  });

  it('still publishes the last draft when nothing was wrong with it', async () => {
    // The contrast: with no code objection standing, an exhausted Round falls
    // back on a draft the checks had passed, and a run completes.
    let round = 0;
    const outcome = await runProposerEvaluatorLoop<Draft>({
      propose: async () => {
        round += 1;
        return round === 1 ? draft('checked-and-clean') : refinementFailure('no draft at all');
      },
      validate: async () => [],
      evaluate: async ({ roundN }) => ({
        kind: 'objections',
        objections: [`a matter of judgement at round ${roundN}`],
        rubric: {},
        text: 'objecting',
      }),
    });

    expect(outcome.evaluatorOutcome).toBe('published_with_objections');
    expect(outcome.draft).toEqual({ id: 'checked-and-clean' });
  });
});

describe('non-convergence PUBLISHES — a run must complete', () => {
  it('publishes with objections at MAX_ROUNDS', async () => {
    const outcome = await runProposerEvaluatorLoop<Draft>({
      propose: async ({ roundN }) => draft(`round-${roundN}`),
      validate: async () => [],
      evaluate: async ({ roundN }) => ({
        kind: 'objections',
        objections: [`still wrong at round ${roundN}`],
        rubric: {},
        text: 'objecting',
      }),
    });

    expect(outcome.evaluatorOutcome).toBe('published_with_objections');
    expect(outcome.roundsUsed).toBe(MAX_ROUNDS);
    // A DRAFT IS STILL PUBLISHED. Failing to converge is a recorded
    // disagreement, not an error.
    expect(outcome.draft).toEqual({ id: `round-${MAX_ROUNDS}` });
  });

  it('assembles dissent from the surviving objections — NOBODY WRITES IT', async () => {
    const outcome = await runProposerEvaluatorLoop<Draft>({
      propose: async ({ roundN }) => draft(`round-${roundN}`),
      validate: async () => [],
      evaluate: async () => ({
        kind: 'objections',
        objections: ['the ownership claim is beyond the record'],
        rubric: {},
        text: 'objecting',
      }),
    });
    expect(outcome.dissent).toHaveLength(1);
    expect(outcome.dissent[0]!.objection).toBe('the ownership claim is beyond the record');
  });

  it('pairs each surviving objection with the reply it drew', async () => {
    // Dissent is the objections a version published without resolving, EACH
    // WITH THE REPLY IT DREW — which is what makes it readable rather than a
    // list of complaints.
    let round = 0;
    const outcome = await runProposerEvaluatorLoop<Draft>({
      propose: async () => {
        round += 1;
        return { kind: 'draft', draft: { id: `r${round}` }, text: `reply in round ${round}` };
      },
      validate: async () => [],
      evaluate: async () => ({
        kind: 'objections',
        objections: ['unresolved'],
        rubric: {},
        text: 'no',
      }),
    });
    expect(outcome.dissent[0]!.reply).toMatch(/reply in round/);
  });
});

describe('convergence', () => {
  it('passes in one round when nothing objects', async () => {
    const outcome = await runProposerEvaluatorLoop<Draft>({
      propose: async () => draft('a'),
      validate: async () => [],
      evaluate: async () => ({ kind: 'pass', rubric: {}, text: 'ok' }),
    });
    expect(outcome.evaluatorOutcome).toBe('passed');
    expect(outcome.roundsUsed).toBe(1);
    expect(outcome.dissent).toEqual([]);
  });

  it('records a rubric on every evaluator round', async () => {
    // What the evaluator submitted, stored whole — `round.rubric` is jsonb and
    // documented as the six rubric verdicts, so it holds the payload rather
    // than a transcript of the reply that carried it.
    const rubric = {
      items: [{ item: 'support', verdict: 'pass', reasoning: 'every cited row carries its claim' }],
      summary: 'the draft holds up',
    };
    const outcome = await runProposerEvaluatorLoop<Draft>({
      propose: async () => draft('a'),
      validate: async () => [],
      evaluate: async () => ({ kind: 'pass', rubric, text: 'support — pass' }),
    });
    expect(
      outcome.rounds.find((r) => r.role === 'evaluator' && r.source === 'model')!.rubric,
    ).toEqual(rubric);
  });
});

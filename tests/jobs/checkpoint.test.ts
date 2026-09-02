import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as t from '@/db/schema';
import { loadRoundCheckpoint, saveRoundCheckpoint } from '@/jobs/checkpoint';
import { runProposerEvaluatorLoop, type RoundState } from '@/jobs/rounds';
import { enqueueJob, finishJob, openRun, requeueJobs } from '@/jobs/runs';
import { MAX_ROUNDS } from '@/config/constants';
import { getTestDb, testDatabaseIsUp, testSql, type TestDb } from '../support/test-db';

/**
 * The resume checkpoint (SPEC §5.3, §18.2).
 *
 * **A Round is the smallest resumable unit**, and `job_round.checkpoint` is
 * where that claim is kept. It was written by nothing, so a paused Job resumed
 * by starting again — re-spending the Rounds a person had just agreed to pay
 * for, and re-asking a question the agents had already answered.
 */

type Draft = { text: string };

describe('the ladder resumes at the Round it reached', () => {
  it('continues from the next Round, carrying the objections that Round drew', async () => {
    const saved: { roundN: number; state: RoundState<Draft> }[] = [];
    const proposed: { roundN: number; objections: string[] }[] = [];

    // ── The paused attempt: two Rounds of code rejections, then a stop ───────
    const paused = await runProposerEvaluatorLoop<Draft>({
      maxRounds: 2,
      propose: async ({ roundN, objections }) => {
        proposed.push({ roundN, objections });
        return { kind: 'draft', draft: { text: `round ${roundN}` }, text: '' };
      },
      validate: async () => [{ check: 'citations', message: 'points at nothing' }],
      evaluate: async () => {
        throw new Error('the evaluator must not run on a draft the code rejected');
      },
      checkpoint: {
        load: async () => undefined,
        save: async (roundN, state) => {
          saved.push({ roundN, state: structuredClone(state) });
        },
      },
    });
    expect(paused.evaluatorOutcome).toBe('rejected_by_code');
    expect(saved.map((entry) => entry.roundN)).toEqual([1, 2]);

    // ── The resumed attempt: it starts at Round 3, not at Round 1 ────────────
    const resumedProposals: number[] = [];
    const last = saved.at(-1)!;
    await runProposerEvaluatorLoop<Draft>({
      propose: async ({ roundN, objections }) => {
        resumedProposals.push(roundN);
        // The objection the paused Round drew is the one this Round answers.
        expect(objections).toEqual(['points at nothing']);
        return { kind: 'draft', draft: { text: `round ${roundN}` }, text: '' };
      },
      validate: async () => [],
      evaluate: async () => ({ kind: 'pass', rubric: {}, text: '' }),
      checkpoint: {
        load: async () => ({ roundN: last.roundN, state: last.state }),
        save: async () => {},
      },
    });

    expect(resumedProposals, 'a resume that restarted would propose round 1 again').toEqual([
      MAX_ROUNDS,
    ]);
  });
});

describe('job_round holds one row per Round boundary', () => {
  it('replaces a Round it has already recorded rather than colliding on (job, n)', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    const { jobId } = await scratchJob(db);

    await saveRoundCheckpoint(db, jobId, 1, { note: 'first' });
    await saveRoundCheckpoint(db, jobId, 1, { note: 'restarted' });
    await saveRoundCheckpoint(db, jobId, 2, { note: 'second' });

    const latest = await loadRoundCheckpoint<{ note: string }>(db, jobId);
    expect(latest).toEqual({ n: 2, checkpoint: { note: 'second' } });

    const rows = await db.select().from(t.jobRound).where(eq(t.jobRound.jobId, jobId));
    expect(rows).toHaveLength(2);
  });

  it('is discarded by a retry, because a Job at its ceiling is re-runnable and never resumable', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    const { jobId } = await scratchJob(db);

    await saveRoundCheckpoint(db, jobId, 1, { note: 'a round somebody wants re-run' });
    await finishJob(db, jobId, { state: 'terminated', reason: 'stopped at a ceiling' });
    await requeueJobs(db, [jobId]);

    expect(await loadRoundCheckpoint(db, jobId)).toBeUndefined();
    const job = await db.query.job.findFirst({ where: eq(t.job.id, jobId) });
    expect(job!.state).toBe('queued');
    // The attempt counter still counts up: "this has been tried three times" is
    // the fact a person deciding whether to try again needs.
    expect(job!.attempt).toBe(1);
  });
});

async function scratchJob(db: TestDb): Promise<{ jobId: string }> {
  const [program] = await testSql()`
    INSERT INTO program (name, importing_country, vehicle_class, sourcing_horizon)
    VALUES ('checkpoint fixture', 'USA', 'BEV', 'FY2027')
    RETURNING id`;
  const runId = await openRun(db, {
    programId: program!.id,
    trigger: 'full',
    supplierCount: 1,
  });
  const jobId = await enqueueJob(db, {
    runId,
    kind: 'assess',
    subjectType: 'program',
    subjectId: program!.id,
  });
  return { jobId };
}

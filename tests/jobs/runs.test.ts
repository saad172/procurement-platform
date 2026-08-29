import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as t from '@/db/schema';
import {
  checkRunBudget,
  dequeueJob,
  enqueueJob,
  finishJob,
  openRun,
  resumeRun,
  runSpendUsd,
  settleRunState,
} from '@/jobs/runs';
import { runWorker } from '@/worker/poll';
import { RUN_BUDGET_USD_PER_SUPPLIER } from '@/config/constants';
import {
  START_TEST_DB_HINT,
  closeTestDb,
  getTestDb,
  testDatabaseIsUp,
  testSql,
  type TestDb,
} from '../support/test-db';

/**
 * SPEC §5, §18. The properties worth proving are the ones the run/Job
 * distinction rests on:
 *
 * - `terminated` names a number you set; `failed` names something that broke,
 *   and a terminated Job does not fail its run;
 * - `paused_on_budget` is the only state that returns to `running`;
 * - two workers never take the same Job.
 */

const up = await testDatabaseIsUp();

describe.skipIf(!up)(`runs and jobs (needs: ${START_TEST_DB_HINT})`, () => {
  let db: TestDb;
  let programId: string;

  beforeAll(async () => {
    db = await getTestDb();
    await testSql()`DELETE FROM program WHERE name = 'runs fixture'`;
    const [program] = await testSql()`
      INSERT INTO program (name, importing_country, vehicle_class, sourcing_horizon)
      VALUES ('runs fixture', 'USA', 'BEV', 'FY2027') RETURNING id`;
    programId = program!.id;
  });

  beforeEach(async () => {
    await testSql()`DELETE FROM run WHERE program_id = ${programId}`;
  });

  afterAll(async () => {
    if (!up) return;
    await testSql()`DELETE FROM program WHERE name = 'runs fixture'`;
    await closeTestDb();
  });

  describe('a Run carries the budget its Supplier count implies', () => {
    it('is $3.00 × N', async () => {
      const runId = await openRun(db, { programId, trigger: 'full', supplierCount: 10 });
      const run = await db.query.run.findFirst({ where: eq(t.run.id, runId) });
      expect(Number(run!.budgetUsd)).toBe(RUN_BUDGET_USD_PER_SUPPLIER * 10);
    });

    it('gives a Thread’s Run NO budget, because the confirm gate is the bound', async () => {
      // A Thread has no N, and chat's inline lookups never reach a dequeue
      // point or a Round boundary. Every chat spend is a person pressing a
      // button with an estimate in front of them, which is the stronger bound.
      const runId = await openRun(db, { programId, trigger: 'thread' });
      const run = await db.query.run.findFirst({ where: eq(t.run.id, runId) });
      expect(run!.budgetUsd).toBeNull();
    });
  });

  describe('dequeue with FOR UPDATE SKIP LOCKED', () => {
    it('gives one Job to exactly one caller, even when several ask at once', async () => {
      // The whole reason the worker needs DIRECT_DATABASE_URL rather than the
      // transaction pooler: the lock is held across statements in one session.
      const runId = await openRun(db, { programId, trigger: 'full', supplierCount: 1 });
      await enqueueJob(db, { runId, kind: 'enrich', subjectType: 'program', subjectId: programId });

      const claims = await Promise.all([dequeueJob(db), dequeueJob(db), dequeueJob(db)]);
      const claimed = claims.filter(Boolean);
      expect(claimed).toHaveLength(1);
      expect(claimed[0]!.state).toBe('running');
    });

    it('hands out different Jobs to concurrent callers rather than blocking', async () => {
      const runId = await openRun(db, { programId, trigger: 'full', supplierCount: 3 });
      for (let i = 0; i < 3; i += 1) {
        await enqueueJob(db, { runId, kind: 'enrich', subjectType: 'program', subjectId: programId });
      }
      const claims = await Promise.all([dequeueJob(db), dequeueJob(db), dequeueJob(db)]);
      const ids = claims.filter(Boolean).map((j) => j!.id);
      expect(new Set(ids).size).toBe(3);
    });

    it('takes the oldest queued Job first', async () => {
      const runId = await openRun(db, { programId, trigger: 'full', supplierCount: 2 });
      const first = await enqueueJob(db, { runId, kind: 'enrich', subjectType: 'program', subjectId: programId });
      await new Promise((r) => setTimeout(r, 5));
      await enqueueJob(db, { runId, kind: 'assess', subjectType: 'program', subjectId: programId });
      const claimed = await dequeueJob(db);
      expect(claimed!.id).toBe(first);
    });
  });

  describe('terminated is not failed', () => {
    it('a terminated Job does NOT fail its run', async () => {
      // The run continues and reports "N jobs stopped at their ceiling".
      const runId = await openRun(db, { programId, trigger: 'full', supplierCount: 2 });
      const a = await enqueueJob(db, { runId, kind: 'resolve', subjectType: 'program', subjectId: programId });
      const b = await enqueueJob(db, { runId, kind: 'resolve', subjectType: 'program', subjectId: programId });

      await finishJob(db, a, { state: 'terminated', reason: 'stopped at its 60-tool-call ceiling' });
      await finishJob(db, b, { state: 'done' });
      await settleRunState(db, runId);

      const run = await db.query.run.findFirst({ where: eq(t.run.id, runId) });
      expect(run!.state).toBe('done');
      const job = await db.query.job.findFirst({ where: eq(t.job.id, a) });
      expect(job!.terminatedReason).toMatch(/60-tool-call ceiling/);
    });

    it('a failed Job DOES fail its run', async () => {
      const runId = await openRun(db, { programId, trigger: 'full', supplierCount: 1 });
      const a = await enqueueJob(db, { runId, kind: 'resolve', subjectType: 'program', subjectId: programId });
      await finishJob(db, a, { state: 'failed', error: 'the model refused' });
      await settleRunState(db, runId);
      const run = await db.query.run.findFirst({ where: eq(t.run.id, runId) });
      expect(run!.state).toBe('failed');
    });

    it('carries the Job caps its kind declares', async () => {
      const runId = await openRun(db, { programId, trigger: 'full', supplierCount: 1 });
      const id = await enqueueJob(db, { runId, kind: 'recommend', subjectType: 'program', subjectId: programId });
      const job = await db.query.job.findFirst({ where: eq(t.job.id, id) });
      expect(job!.toolCallCap).toBe(60);
      expect(job!.tokenCap).toBe(900_000);
    });

    it('marks a Dossier’s Trace as `timeline`, which cannot drive a replay', async () => {
      const runId = await openRun(db, { programId, trigger: 'dossier', supplierCount: 1 });
      const id = await enqueueJob(db, { runId, kind: 'dossier', subjectType: 'program', subjectId: programId });
      const job = await db.query.job.findFirst({ where: eq(t.job.id, id) });
      expect(job!.traceFidelity).toBe('timeline');
    });
  });

  describe('paused_on_budget is the only state that returns to running', () => {
    it('pauses a Job when the run budget is spent, without dequeuing more', async () => {
      const runId = await openRun(db, { programId, trigger: 'full', supplierCount: 1 });
      await enqueueJob(db, { runId, kind: 'assess', subjectType: 'program', subjectId: programId });
      await enqueueJob(db, { runId, kind: 'assess', subjectType: 'program', subjectId: programId });

      // Spend past the $3.00 budget.
      await testSql()`
        INSERT INTO usage_event (run_id, endpoint, ms, outcome, model, input_tokens, output_tokens)
        VALUES (${runId}, 'messages.toolRunner', 10, 'ok', 'claude-opus-5', 0, 200000)`;
      const budget = await checkRunBudget(db, runId);
      expect(budget.withinBudget).toBe(false);
      expect(await runSpendUsd(db, runId)).toBeCloseTo(5, 6);

      let idled = 0;
      await runWorker(db, {
        concurrency: 2,
        pollIntervalMs: 1,
        handlers: { assess: async () => ({ state: 'done' as const }) },
        shouldStop: () => idled > 0,
        onIdle: () => { idled += 1; },
      });

      const jobs = await db.select().from(t.job).where(eq(t.job.runId, runId));
      expect(jobs.every((j) => j.state === 'paused_on_budget')).toBe(true);
    });

    it('resume raises the budget by the same $3 × N formula and re-queues', async () => {
      // A flat step would be arbitrary; a free-text box would hole the
      // code-constant discipline.
      const runId = await openRun(db, { programId, trigger: 'full', supplierCount: 10 });
      const a = await enqueueJob(db, { runId, kind: 'assess', subjectType: 'program', subjectId: programId });
      const b = await enqueueJob(db, { runId, kind: 'assess', subjectType: 'program', subjectId: programId });
      await finishJob(db, a, { state: 'paused_on_budget' });
      await finishJob(db, b, { state: 'paused_on_budget' });

      const { addedUsd } = await resumeRun(db, runId);
      expect(addedUsd).toBe(RUN_BUDGET_USD_PER_SUPPLIER * 2);

      const run = await db.query.run.findFirst({ where: eq(t.run.id, runId) });
      expect(Number(run!.budgetUsd)).toBe(30 + addedUsd);
      expect(run!.state).toBe('running');

      const jobs = await db.select().from(t.job).where(eq(t.job.runId, runId));
      expect(jobs.every((j) => j.state === 'queued')).toBe(true);
    });
  });

  describe('the worker', () => {
    it('runs a Job to completion and settles the run', async () => {
      const runId = await openRun(db, { programId, trigger: 'full', supplierCount: 1 });
      await enqueueJob(db, { runId, kind: 'enrich', subjectType: 'program', subjectId: programId });

      const seen: string[] = [];
      let idled = 0;
      await runWorker(db, {
        concurrency: 4,
        pollIntervalMs: 1,
        handlers: {
          enrich: async (job) => {
            seen.push(job.id);
            return { state: 'done' as const };
          },
        },
        shouldStop: () => idled > 0,
        onIdle: () => { idled += 1; },
      });

      expect(seen).toHaveLength(1);
      const run = await db.query.run.findFirst({ where: eq(t.run.id, runId) });
      expect(run!.state).toBe('done');
    });

    it('fails a Job whose handler throws — never terminates it', async () => {
      const runId = await openRun(db, { programId, trigger: 'full', supplierCount: 1 });
      await enqueueJob(db, { runId, kind: 'enrich', subjectType: 'program', subjectId: programId });

      let idled = 0;
      await runWorker(db, {
        concurrency: 1,
        pollIntervalMs: 1,
        handlers: { enrich: async () => { throw new Error('upstream exploded'); } },
        shouldStop: () => idled > 0,
        onIdle: () => { idled += 1; },
      });

      const jobs = await db.select().from(t.job).where(eq(t.job.runId, runId));
      expect(jobs[0]!.state).toBe('failed');
      expect(jobs[0]!.error).toMatch(/upstream exploded/);
    });

    it('fails a Job with no registered handler rather than silently dropping it', async () => {
      const runId = await openRun(db, { programId, trigger: 'full', supplierCount: 1 });
      await enqueueJob(db, { runId, kind: 'discover', subjectType: 'program', subjectId: programId });
      let idled = 0;
      await runWorker(db, {
        concurrency: 1,
        pollIntervalMs: 1,
        handlers: {},
        shouldStop: () => idled > 0,
        onIdle: () => { idled += 1; },
      });
      const jobs = await db.select().from(t.job).where(eq(t.job.runId, runId));
      expect(jobs[0]!.state).toBe('failed');
      expect(jobs[0]!.error).toMatch(/no handler registered/);
    });
  });
});

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as t from '@/db/schema';
import { JOB_CAPS, RUN_BUDGET_USD_PER_SUPPLIER, type JobKind } from '@/config/constants';
import { priceOf } from '@/lib/price';

/**
 * Runs and Jobs (SPEC §5, §18).
 *
 * **Every amount the app spends sits inside exactly one Run, with no orphan
 * path.** That is why settling a parked Supplier, a Deep Traversal, a
 * re-assessment and a re-run each start a Run of their own, and why a Thread's
 * first *model* turn lazily opens one. The knowingly-accepted cost is a longer
 * Runs list; what it buys is that no spend is unattributable.
 */

export type RunTrigger =
  /**
   * **The whole pipeline, chained.** A `pipeline` Run carries a Supplier
   * through resolve → enrich → assess, each stage queued by the worker as the
   * one before it succeeds. It is a distinct trigger rather than a flag because
   * the chain must NOT fire for the Supplier-page buttons: Re-enrich and
   * Re-assess are deliberately separate controls answering different questions,
   * and a Re-enrich that silently rewrote the assessment would answer the one
   * the reviewer did not ask.
   */
  | 'pipeline'
  /**
   * One company's own record, fetched because a person asked for it.
   *
   * Its own trigger rather than `full`, because the Runs list is read to answer
   * *what did this cost and why*, and "fetch record" is a different answer from
   * "a roster ran".
   */
  | 'fetch_record'
  | 'full'
  | 'settlement'
  | 'traverse'
  | 'reassess'
  | 'rerun_recommendation'
  | 'discover'
  | 'dossier'
  | 'thread';

/**
 * Opens a Run.
 *
 * `budgetUsd` is `$8.00 × N Suppliers` — a **soft ceiling with bounded
 * overshoot**, not a hard stop, because a Round is the smallest resumable unit
 * and checking finer would only discard spend already made.
 *
 * A Thread's Run carries **no budget**: a Thread has no N, and chat's inline
 * lookups never reach a dequeue point or a Round boundary. **The confirm gate
 * is the bound there, and it is the stronger one** — every chat spend is a
 * person pressing a button with an estimate in front of them.
 */
export async function openRun(
  db: Database,
  args: {
    programId: string;
    trigger: RunTrigger;
    subjectLabel?: string | undefined;
    supplierCount?: number | undefined;
    threadId?: string | undefined;
  },
): Promise<string> {
  const budget =
    args.trigger === 'thread' || args.supplierCount == null
      ? null
      : (RUN_BUDGET_USD_PER_SUPPLIER * args.supplierCount).toFixed(4);

  const [row] = await db
    .insert(t.run)
    .values({
      programId: args.programId,
      state: 'queued',
      trigger: args.trigger,
      subjectLabel: args.subjectLabel ?? null,
      supplierCount: args.supplierCount ?? null,
      budgetUsd: budget,
      // Labelled "up to" in the UI, because it assumes every Job runs to
      // MAX_ROUNDS. The accumulating gap between this and the actual is itself
      // the evidence the estimator is ceiling-shaped.
      estimateUsd: budget,
      threadId: args.threadId ?? null,
    })
    .returning({ id: t.run.id });
  return row!.id;
}

/** Enqueues one Job with the caps its kind carries. */
export async function enqueueJob(
  db: Database,
  args: {
    runId: string;
    kind: JobKind;
    subjectType: 'supplier' | 'category' | 'entity' | 'program';
    subjectId: string;
  },
): Promise<string> {
  const caps = JOB_CAPS[args.kind];
  const [row] = await db
    .insert(t.job)
    .values({
      runId: args.runId,
      kind: args.kind,
      subjectType: args.subjectType,
      subjectId: args.subjectId,
      state: 'queued',
      toolCallCap: caps.toolCalls,
      tokenCap: caps.tokens,
      // A Dossier's context is rewritten server-side, so its Trace cannot drive
      // a replay and says so rather than pretending otherwise.
      traceFidelity: args.kind === 'dossier' ? 'timeline' : 'replayable',
    })
    .returning({ id: t.job.id });
  return row!.id;
}

/**
 * Dequeues one Job with `FOR UPDATE SKIP LOCKED`.
 *
 * This is why the worker needs `DIRECT_DATABASE_URL` rather than the
 * transaction pooler: the lock has to be held across statements inside one
 * session, and the pooler does not hold a session.
 *
 * Skipping locked rows rather than waiting is what lets four workers share one
 * queue without any of them blocking on a Job another already took.
 */
export async function dequeueJob(db: Database): Promise<typeof t.job.$inferSelect | undefined> {
  const rows = await db.transaction(async (tx) => {
    const claimed = await tx.execute(sql`
      SELECT id FROM ${t.job}
      WHERE ${t.job.state} = 'queued'
      ORDER BY ${t.job.createdAt} ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `);
    const id = (claimed as unknown as { id: string }[])[0]?.id;
    if (!id) return [];
    return tx
      .update(t.job)
      .set({ state: 'running', startedAt: new Date(), lockedAt: new Date() })
      .where(eq(t.job.id, id))
      .returning();
  });
  return rows[0];
}

/**
 * What a Run has actually spent, from `usage_event` — the one home of usage.
 *
 * Computed from a **committed price constant, not a bill**, and the UI says so
 * wherever it renders a dollar figure. The arithmetic itself lives in
 * `src/lib/price.ts`: it was written out here, in `db/queries/runs.ts` and in
 * the model chokepoint, and all three priced a cached read at the plain input
 * rate.
 *
 * An upstream row prices at zero, because Sayari publishes no per-call price —
 * so this bounds Anthropic dollars and nothing else, which is why the per-Job
 * upstream call ceilings had to start being enforced.
 */
export async function runSpendUsd(db: Database, runId: string): Promise<number> {
  const rows = await db
    .select({
      model: t.usageEvent.model,
      inputTokens: t.usageEvent.inputTokens,
      outputTokens: t.usageEvent.outputTokens,
      cacheCreationInputTokens: t.usageEvent.cacheCreationInputTokens,
      cacheReadInputTokens: t.usageEvent.cacheReadInputTokens,
    })
    .from(t.usageEvent)
    .where(eq(t.usageEvent.runId, runId));

  return rows.reduce((sum, row) => sum + priceOf(row), 0);
}

/**
 * The budget check, run **before dequeuing a Job and at each Round boundary**.
 *
 * Concurrency and check-frequency are **one question, not two**: concurrency
 * *is* the overshoot. Worst case is 4 × a ~$0.60 recommend Round ≈ $2.40 on the
 * smallest budget, under 10%.
 */
export async function checkRunBudget(
  db: Database,
  runId: string,
): Promise<{ withinBudget: boolean; spentUsd: number; budgetUsd: number | null }> {
  const run = await db.query.run.findFirst({ where: eq(t.run.id, runId) });
  const spentUsd = await runSpendUsd(db, runId);
  const budgetUsd = run?.budgetUsd == null ? null : Number(run.budgetUsd);
  return { withinBudget: budgetUsd == null || spentUsd < budgetUsd, spentUsd, budgetUsd };
}

/**
 * `terminated` names a number you set; `failed` names something that broke.
 *
 * A terminated Job **does not fail its run** — the run continues and reports
 * "2 jobs stopped at their ceiling". That distinction is the whole of §18.4,
 * and it is why the two states exist rather than one.
 */
export async function finishJob(
  db: Database,
  jobId: string,
  outcome:
    | { state: 'done' }
    | { state: 'terminated'; reason: string }
    | { state: 'failed'; error: string }
    | { state: 'paused_on_budget' },
): Promise<void> {
  await db
    .update(t.job)
    .set({
      state: outcome.state,
      finishedAt: outcome.state === 'paused_on_budget' ? null : new Date(),
      terminatedReason: 'reason' in outcome ? outcome.reason : null,
      error: 'error' in outcome ? outcome.error : null,
      lockedAt: null,
    })
    .where(eq(t.job.id, jobId));
}

/**
 * Puts stopped Jobs back in the queue.
 *
 * **The reset is eight fields, and it lived in two places.** `retryJob` and
 * `retryRun` each carried their own copy of it, verbatim — so a column added to
 * `job` tomorrow would have been cleared by one retry path and left stale by
 * the other, and nothing would have said so. That is the class of mistake
 * `settleMatch()` exists to prevent for a Match, and Runs never got it.
 *
 * `attempt` counts up rather than resetting, because *"this Job has been tried
 * three times"* is the fact a person deciding whether to try again needs, and
 * a requeue that erased it would be hiding the argument against itself.
 *
 * It does **not** settle the Run — the caller does, because a retry of one Job
 * and a retry of every stopped Job in a Run are one act each, and both end with
 * the same single settle.
 */
export async function requeueJobs(db: Database, jobIds: readonly string[]): Promise<void> {
  if (jobIds.length === 0) return;
  await db
    .update(t.job)
    .set({
      state: 'queued',
      error: null,
      terminatedReason: null,
      startedAt: null,
      finishedAt: null,
      lockedAt: null,
      attempt: sql`${t.job.attempt} + 1`,
    })
    .where(inArray(t.job.id, [...jobIds]));
}

/**
 * **Stops a Run**: nothing else is ever dequeued for it, and the Runs list says
 * what happened.
 *
 * It does not interrupt a Job already in flight. The worker holds a claimed Job
 * for the length of its Round and polls nothing, so stopping mid-Round would
 * need either a cancellation channel through the dequeue loop — a second
 * control path — or killing the process, which is not a thing a web page should
 * do. What this buys is the part that matters: **the queue stops.**
 *
 * Queued Jobs are cancelled rather than left queued, because a Run stopped by
 * killing the worker looks identical to one waiting for a worker, and starting
 * a worker later for something else would silently resume it — spending the
 * rest of a budget somebody had decided not to spend.
 */
export async function cancelRun(db: Database, runId: string): Promise<void> {
  const finishedAt = new Date();
  await db
    .update(t.job)
    .set({ state: 'cancelled', finishedAt, lockedAt: null })
    .where(and(eq(t.job.runId, runId), eq(t.job.state, 'queued')));

  await db.update(t.run).set({ state: 'cancelled', finishedAt }).where(eq(t.run.id, runId));
}

/**
 * Closes a Run once none of its Jobs can still move.
 *
 * A run is `done` when nothing is queued, running or paused — **including when
 * some Jobs terminated**, because a ceiling is not a failure of the run.
 */
export async function settleRunState(db: Database, runId: string): Promise<void> {
  const jobs = await db.select({ state: t.job.state }).from(t.job).where(eq(t.job.runId, runId));
  if (jobs.length === 0) return;

  const has = (state: (typeof jobs)[number]['state']) => jobs.some((j) => j.state === state);
  const nextState =
    has('queued') || has('running')
      ? 'running'
      : has('paused_on_budget')
        ? 'paused_on_budget'
        : has('failed')
          ? 'failed'
          : 'done';

  await db
    .update(t.run)
    .set({
      state: nextState,
      finishedAt: nextState === 'done' || nextState === 'failed' ? new Date() : null,
    })
    .where(eq(t.run.id, runId));
}

/**
 * Resuming a paused run is **one act on the run** (SPEC §18.4).
 *
 * `paused_on_budget` is the only state that returns to `running`. The increment
 * derives from the same `$3 × N` formula applied to the Suppliers still
 * unfinished — a flat step would be arbitrary, and a free-text box would hole
 * the code-constant discipline.
 */
export async function resumeRun(db: Database, runId: string): Promise<{ addedUsd: number }> {
  const unfinished = await db
    .select({ id: t.job.id })
    .from(t.job)
    .where(and(eq(t.job.runId, runId), inArray(t.job.state, ['paused_on_budget', 'queued'])));

  const addedUsd = RUN_BUDGET_USD_PER_SUPPLIER * unfinished.length;
  const run = await db.query.run.findFirst({ where: eq(t.run.id, runId) });
  const newBudget = (Number(run?.budgetUsd ?? 0) + addedUsd).toFixed(4);

  await db.update(t.run).set({ budgetUsd: newBudget, state: 'running' }).where(eq(t.run.id, runId));
  await db
    .update(t.job)
    .set({ state: 'queued' })
    .where(and(eq(t.job.runId, runId), eq(t.job.state, 'paused_on_budget')));

  return { addedUsd };
}

import type { Database } from '@/db/client';
import type * as t from '@/db/schema';
import { checkRunBudget, dequeueJob, finishJob, settleRunState } from '@/jobs/runs';

/**
 * The worker's dequeue loop (SPEC §2.2, §18.2).
 *
 * Fixed concurrency **4**, which is not a tuning knob: concurrency *is* the
 * budget overshoot, and 4 is the number the ~10% worst case was sized against.
 *
 * **While a run is paused the worker stops dequeuing its Jobs**, so queued Jobs
 * stay `queued` and resuming is one act on the run rather than N acts on Jobs.
 */

export type JobHandler = (
  job: typeof t.job.$inferSelect,
  db: Database,
) => Promise<
  | { state: 'done' }
  | { state: 'terminated'; reason: string }
  | { state: 'failed'; error: string }
  | { state: 'paused_on_budget' }
>;

export type WorkerOptions = {
  concurrency: number;
  pollIntervalMs: number;
  handlers: Partial<Record<typeof t.job.$inferSelect.kind, JobHandler>>;
  /** Lets a test stop the loop deterministically instead of on a timer. */
  shouldStop?: () => boolean;
  onIdle?: () => void;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runWorker(db: Database, options: WorkerOptions): Promise<void> {
  const inFlight = new Set<Promise<void>>();

  while (!options.shouldStop?.()) {
    if (inFlight.size >= options.concurrency) {
      await Promise.race(inFlight);
      continue;
    }

    const job = await dequeueJob(db);
    if (!job) {
      options.onIdle?.();
      if (options.shouldStop?.()) break;
      await sleep(options.pollIntervalMs);
      continue;
    }

    const task = runOneJob(db, job, options).finally(() => inFlight.delete(task));
    inFlight.add(task);
  }

  await Promise.allSettled(inFlight);
}

async function runOneJob(
  db: Database,
  job: typeof t.job.$inferSelect,
  options: WorkerOptions,
): Promise<void> {
  try {
    // Checked BEFORE the Job runs as well as at each Round boundary inside it.
    // A Job that starts on an exhausted budget would spend a whole Round
    // discovering what we already knew.
    const budget = await checkRunBudget(db, job.runId);
    if (!budget.withinBudget) {
      await finishJob(db, job.id, { state: 'paused_on_budget' });
      await settleRunState(db, job.runId);
      return;
    }

    const handler = options.handlers[job.kind];
    if (!handler) {
      await finishJob(db, job.id, {
        state: 'failed',
        error: `no handler registered for job kind "${job.kind}"`,
      });
    } else {
      await finishJob(db, job.id, await handler(job, db));
    }
  } catch (error) {
    // A thrown handler is `failed` — something broke — never `terminated`,
    // which names a number someone set.
    await finishJob(db, job.id, {
      state: 'failed',
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await settleRunState(db, job.runId);
  }
}

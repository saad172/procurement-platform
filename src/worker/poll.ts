import type { Database } from '@/db/client';
import type * as t from '@/db/schema';
import {
  checkRunBudget,
  dequeueJob,
  finishJob,
  requeueStaleJobs,
  settleRunState,
} from '@/jobs/runs';
import { describeError } from '@/lib/describe-error';
import { UnpublishableDraftError } from '@/jobs/rounds';
import { JobCeilingError, RunPausedError } from '@/jobs/stops';
import { UpstreamCapExceededError } from '@/upstream/errors';

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

/**
 * How often the stale-lock sweep runs.
 *
 * Not every poll: the poll interval is a second and the sweep is two `NOT
 * EXISTS` subqueries over the whole `job` table, while what it looks for takes
 * thirty minutes to become true. A minute is far finer than the thing it
 * detects and far coarser than the loop.
 */
const SWEEP_INTERVAL_MS = 60_000;

export async function runWorker(db: Database, options: WorkerOptions): Promise<void> {
  const inFlight = new Set<Promise<void>>();
  let sweptAt = 0;

  while (!options.shouldStop?.()) {
    if (inFlight.size >= options.concurrency) {
      await Promise.race(inFlight);
      continue;
    }

    if (Date.now() - sweptAt >= SWEEP_INTERVAL_MS) {
      sweptAt = Date.now();
      await sweepStaleLocks(db);
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

/**
 * Puts back the Jobs whose worker went away, and says which.
 *
 * A worker killed mid-Job left its row `running` for ever — no heartbeat, no
 * lock expiry — so the only recovery was a person noticing a Run that had
 * stopped moving and pressing Retry. A swept Job keeps its Round checkpoint, so
 * it continues rather than restarts: it lost its worker, it did not run away.
 *
 * **One line per requeue**, because a Job coming back from nowhere is exactly
 * the kind of thing a reader of the log needs to be able to account for.
 */
async function sweepStaleLocks(db: Database): Promise<void> {
  try {
    const requeued = await requeueStaleJobs(db);
    for (const job of requeued) {
      console.warn(
        `[worker] requeued ${job.kind} job ${job.id}: locked at ${job.lockedAt?.toISOString() ?? 'an unknown time'} ` +
          `and silent since — its worker is gone. It resumes from its last Round boundary.`,
      );
      await settleRunState(db, job.runId);
    }
  } catch (error) {
    // The sweep is recovery, not work: a failure here must not stop the queue.
    console.error('[worker] the stale-lock sweep failed:', error);
  }
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
    /**
     * **`terminated` names a number you set; `failed` names something that
     * broke** (SPEC §18.4) — and three Rounds is a number someone set.
     *
     * `UnpublishableDraftError` exists precisely so a worker can tell the two
     * apart; its own doc says *"the Job did everything it was asked and the
     * answer is that there is nothing publishable — which is a result, not a
     * malfunction."* Nothing read it. Every throw became `failed`, so a draft
     * correctly refused by the citation rules produced a red row reading
     * *something broke*, next to a Run whose whole claim is that it does not
     * publish sentences it cannot support. It is amber, and it says why.
     */
    if (error instanceof RunPausedError) {
      /**
       * **The only stop that returns to `running`** (SPEC §18.2).
       *
       * A budget pause is a spending decision a person may revise, so nothing
       * is red and nothing is amber: the Job waits, its Round checkpoint stands,
       * and `resumeRun` puts it back in the queue to continue from there.
       */
      await finishJob(db, job.id, { state: 'paused_on_budget' });
    } else if (error instanceof JobCeilingError) {
      // A per-Job ceiling: `terminated` names a number you set. Re-runnable,
      // never resumable — a runaway loop is not something a human should be
      // able to wave through.
      await finishJob(db, job.id, { state: 'terminated', reason: error.reason });
    } else if (error instanceof UpstreamCapExceededError) {
      // A ceiling somebody set, so `terminated` and re-runnable — same rule as
      // the model loop's own caps, now applied to the deterministic Jobs that
      // never pass through it.
      await finishJob(db, job.id, { state: 'terminated', reason: error.message });
    } else if (error instanceof UnpublishableDraftError) {
      await finishJob(db, job.id, {
        state: 'terminated',
        reason: describeError(error),
      });
    } else {
      // What gets stored is the *cause*: an ORM's own message is the SQL it
      // attempted, and a page that printed that told the reader the statement
      // and never the reason (see describeError).
      await finishJob(db, job.id, { state: 'failed', error: describeError(error) });
    }
  } finally {
    await settleRunState(db, job.runId);
  }
}

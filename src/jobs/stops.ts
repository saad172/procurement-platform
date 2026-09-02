import type { RunLoopOutcome } from '@/model/types';

/**
 * The two ways a model loop stops that are **not** a malfunction (SPEC §18.2,
 * §18.4).
 *
 * > **`terminated` names a number you set; `failed` names something that
 * > broke.**
 *
 * Both used to be invisible from outside the loop. `runLoop()` returned
 * `terminated` and `paused_on_budget`, and every caller flattened them into
 * `loop_failure` — which buys a ceiling breach two more free retries against
 * the same ceiling, and turns a budget pause into a Job that publishes
 * *"the model loop failed on all 3 attempts"*. No handler ever produced
 * `finishJob({ state: 'terminated' })` and no caller ever supplied a
 * `budgetCheck`, so `paused_on_budget` — *the only state that returns to
 * running* — was unreachable in a graded run.
 *
 * They are thrown rather than threaded back through every ladder's return type
 * for the reason `UnpublishableDraftError` is: a stop that has to be re-declared
 * at each of a dozen call sites is a stop one of them will forget, and the
 * worker's `catch` is where the Job's state is decided anyway. Named classes, so
 * a worker can tell them from a crash.
 */

/** A per-Job ceiling fired. Amber, re-runnable, and **never resumable**. */
export class JobCeilingError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'JobCeilingError';
  }
}

/**
 * The Run's budget was reached at a Round boundary.
 *
 * A spending decision a person may revise, so the Job **pauses** rather than
 * terminating and resumes from its last Round checkpoint. Nothing is wrong with
 * it; it is waiting.
 */
export class RunPausedError extends Error {
  constructor(readonly spentUsd: number) {
    super(`paused at the run budget, with $${spentUsd.toFixed(2)} spent`);
    this.name = 'RunPausedError';
  }
}

/**
 * Raises the stop a loop outcome carries, and returns for everything else.
 *
 * `failed` deliberately falls through: a transport error or a truncated turn is
 * worth another attempt on the same Round's free-retry budget, and the callers
 * already report it as itself rather than as a mis-shaped draft (finding 72).
 */
export function raiseIfStopped(result: RunLoopOutcome): void {
  if (result.status === 'terminated') throw new JobCeilingError(result.reason);
  if (result.status === 'paused_on_budget') throw new RunPausedError(result.spentUsd);
}

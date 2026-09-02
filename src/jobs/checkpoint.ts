import { desc, eq } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as t from '@/db/schema';

/**
 * The resume checkpoint (SPEC §5.3, §18.2).
 *
 * **A Round is the smallest resumable unit**, which is why the run budget
 * pauses at a Round boundary and why checking finer would only discard spend
 * already made. `job_round.checkpoint` has existed since the first migration
 * and was written by nothing, so *"resume"* meant *"start the Job again"* — the
 * one act the budget pause exists to avoid, since the Rounds already paid for
 * are exactly the spend a person agreed to.
 *
 * **Completed Rounds survive; the in-flight Round restarts.** Mid-loop message
 * rehydration was rejected and stays rejected: orphaned `tool_use` blocks and
 * half-written tool results are a bug class not worth the tokens saved, and the
 * upstream cache means a replayed Round costs tokens, not credits.
 *
 * What a checkpoint holds is the ladder's own state, not the model's — the
 * drafts, objections and Rounds a resumed attempt has to be able to restate.
 * Each ladder declares its own shape; this module only stores and finds them.
 */

/** Writes the boundary of Round `n`, replacing one already there. */
export async function saveRoundCheckpoint(
  db: Database,
  jobId: string,
  n: number,
  checkpoint: unknown,
): Promise<void> {
  await db
    .insert(t.jobRound)
    .values({ jobId, n, checkpoint: checkpoint as never })
    .onConflictDoUpdate({
      // A re-run of the same Round overwrites its boundary rather than
      // colliding on `(job_id, n)` — the Round that restarts is the one that
      // did not finish, and its old boundary describes a state nothing reached.
      target: [t.jobRound.jobId, t.jobRound.n],
      set: { checkpoint: checkpoint as never, completedAt: new Date() },
    });
}

/**
 * The last Round this Job finished, or nothing if it never finished one.
 *
 * Read once, at the start of an attempt. A Job on its first attempt has no
 * checkpoint and starts at Round 1, which is the same code path.
 */
export async function loadRoundCheckpoint<T>(
  db: Database,
  jobId: string,
): Promise<{ n: number; checkpoint: T } | undefined> {
  const [row] = await db
    .select({ n: t.jobRound.n, checkpoint: t.jobRound.checkpoint })
    .from(t.jobRound)
    .where(eq(t.jobRound.jobId, jobId))
    .orderBy(desc(t.jobRound.n))
    .limit(1);

  return row ? { n: row.n, checkpoint: row.checkpoint as T } : undefined;
}

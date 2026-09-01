import { eq } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as t from '@/db/schema';
import { loadRunInsights, loadRuns, activeRun } from '@/db/queries/runs';
import { runsAnswer } from '@/domain/runs-answer';
import { inArray } from 'drizzle-orm';

/**
 * Everything this page renders, in one read (SPEC §13.1).
 *
 * A page reads through `db/queries`, never through the schema — see
 * `supplier-page.ts` for why.
 */
export async function loadRunsPage(db: Database, args: { programId: string }) {
  const { programId } = args;

  const program = await db.query.program.findFirst({ where: eq(t.program.id, programId) });
  if (!program) return undefined;

  const runs = await loadRuns(db, programId);
  const running = await activeRun(db, programId);
  const insights = await loadRunInsights(db, programId);
  const totalUsd = runs.reduce((sum, r) => sum + r.actualUsd, 0);

  /**
   * Every job of every run, so the page can say what was left undone.
   *
   * `loadRuns` counts jobs by state per run but not the ones that never began,
   * and "43 never started" is the whole explanation for why only three
   * suppliers have a write-up — the single most useful sentence this page can
   * produce, from data it already had.
   */
  const jobs = runs.length
    ? await db
        .select({
          runId: t.job.runId,
          state: t.job.state,
          subjectId: t.job.subjectId,
          error: t.job.error,
        })
        .from(t.job)
        .where(
          inArray(
            t.job.runId,
            runs.map((r) => r.run.id),
          ),
        )
    : [];

  /**
   * Failures that were **our own checks refusing to publish**, as against
   * anything upstream going wrong. The distinction matters enough to be made
   * on the surface: one is the system working and the other is not, and on a
   * ledger they look identical.
   */
  const refusedIds = jobs.filter(
    (job) => job.state === 'failed' && job.error?.includes('rejected by our own checks'),
  );
  const refusedSuppliers = refusedIds.length
    ? await db
        .select({ id: t.supplier.id, rosterName: t.supplier.rosterName })
        .from(t.supplier)
        .where(
          inArray(
            t.supplier.id,
            refusedIds.map((job) => job.subjectId),
          ),
        )
    : [];
  const nameOf = new Map(refusedSuppliers.map((row) => [row.id, row.rosterName]));

  const answers = runsAnswer({
    runs: runs.map((summary) => {
      const runJobs = jobs.filter((job) => job.runId === summary.run.id);
      return {
        id: summary.run.id,
        label: summary.run.subjectLabel ?? 'A run',
        state: summary.run.state,
        jobs: {
          total: runJobs.length,
          done: runJobs.filter((job) => job.state === 'done').length,
          failed: runJobs.filter((job) => job.state === 'failed').length,
          // Cancelled and still queued are both "never began", and to a reader
          // asking why the work is not done they are the same fact.
          neverStarted: runJobs.filter((job) => job.state === 'cancelled' || job.state === 'queued')
            .length,
        },
        actualUsd: summary.actualUsd,
      };
    }),
    refusedByOurChecks: refusedIds.map((job) => ({
      subjectLabel: nameOf.get(job.subjectId) ?? 'a supplier',
      runId: job.runId,
    })),
    totalUsd,
    runHref: (runId) => `/program/${programId}/runs/${runId}`,
  });

  return {
    program,
    runs,
    running,
    insights,
    totalUsd,
    answers,
  };
}

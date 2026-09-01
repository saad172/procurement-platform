import { eq, inArray } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as t from '@/db/schema';
import { runSpendUsd } from '@/jobs/runs';
import {
  loadJobActivity,
  retryableJobs,
  runPhases,
  runProgress,
  loadWorkerHealth,
} from '@/db/queries/runs';

/**
 * Everything this page renders, in one read (SPEC §13.1).
 *
 * A page reads through `db/queries`, never through the schema — see
 * `supplier-page.ts` for why.
 */
export async function loadRunPage(db: Database, args: { programId: string; runId: string }) {
  const { programId, runId } = args;

  const run = await db.query.run.findFirst({ where: eq(t.run.id, runId) });
  const program = await db.query.program.findFirst({ where: eq(t.program.id, programId) });
  if (!run || !program) return undefined;

  const jobs = await db.select().from(t.job).where(eq(t.job.runId, runId)).orderBy(t.job.createdAt);

  const progress = runProgress(jobs);
  /**
   * Counted from the Trace, not from `job.tool_calls_used` — those two columns
   * are written by nothing, so the old `0 / 40` was not a slow number, it was
   * an absent one. The Trace rows land turn by turn, which is what makes this
   * readable while the Job is still running.
   */
  const activity = await loadJobActivity(
    db,
    jobs.map((job) => job.id),
  );
  const subjects = await loadSubjects(db, jobs);

  // What resuming would actually pay for: the jobs that never finished.
  const unfinished = jobs.filter(
    (job) => job.state === 'queued' || job.state === 'paused_on_budget',
  ).length;
  const actualUsd = await runSpendUsd(db, runId);
  /**
   * Liveness, asked once. It answers two questions on this page: whether queued
   * jobs will ever be picked up, and whether a job sitting in `running` is
   * working or orphaned by a worker that died holding it.
   */
  const { workerUp, nowMs } = await loadWorkerHealth(db);
  const phases = runPhases(jobs);
  const stuck = retryableJobs(jobs, workerUp, nowMs);

  return {
    run,
    program,
    jobs,
    progress,
    activity,
    subjects,
    unfinished,
    actualUsd,
    phases,
    stuck,
    workerUp,
  };
}

/** What each Job is about, by id. It queries, so it was never page code. */
/**
 * The names behind the subject ids, in two queries rather than one per row.
 */
async function loadSubjects(
  db: Database,
  jobs: (typeof t.job.$inferSelect)[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();

  const supplierIds = jobs
    .filter((job) => job.subjectType === 'supplier')
    .map((job) => job.subjectId);
  if (supplierIds.length > 0) {
    const rows = await db
      .select({ id: t.supplier.id, name: t.supplier.rosterName })
      .from(t.supplier)
      .where(inArray(t.supplier.id, supplierIds));
    for (const row of rows) names.set(row.id, row.name ?? row.id.slice(0, 12));
  }

  const categoryIds = jobs
    .filter((job) => job.subjectType === 'category')
    .map((job) => job.subjectId);
  if (categoryIds.length > 0) {
    const rows = await db
      .select({ id: t.category.id, code: t.category.code, name: t.category.name })
      .from(t.category)
      .where(inArray(t.category.id, categoryIds));
    for (const row of rows) names.set(row.id, `${row.code} · ${row.name}`);
  }

  return names;
}

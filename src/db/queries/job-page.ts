import { eq } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as t from '@/db/schema';

/**
 * Everything this page renders, in one read (SPEC §13.1).
 *
 * A page reads through `db/queries`, never through the schema — see
 * `supplier-page.ts` for why.
 */
export async function loadJobPage(
  db: Database,
  args: { programId: string; runId: string; jobId: string },
) {
  const { programId, jobId } = args;

  const job = await db.query.job.findFirst({ where: eq(t.job.id, jobId) });
  const program = await db.query.program.findFirst({ where: eq(t.program.id, programId) });
  if (!job || !program) return undefined;

  const turns = await db
    .select()
    .from(t.traceTurn)
    .where(eq(t.traceTurn.jobId, jobId))
    .orderBy(t.traceTurn.n);

  const usage = await db.select().from(t.usageEvent).where(eq(t.usageEvent.jobId, jobId));

  return {
    job,
    program,
    turns,
    usage,
  };
}

import { eq } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as t from '@/db/schema';
import { loadParked } from '@/db/queries/needs-review';

/**
 * Everything this page renders, in one read (SPEC §13.1).
 *
 * A page reads through `db/queries`, never through the schema — see
 * `supplier-page.ts` for why.
 */
export async function loadNeedsReviewPage(
  db: Database,
  args: { programId: string },
) {
  const { programId } = args;

  const program = await db.query.program.findFirst({ where: eq(t.program.id, programId) });
  if (!program) return undefined;

  const waiting = await loadParked(db, programId);
  const decidable = waiting.filter((row) => row.candidateCount > 0).length;

  return {
    program,
    waiting,
    decidable,
  };
}

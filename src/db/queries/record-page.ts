import { eq } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as t from '@/db/schema';

/**
 * One source record, and the Program it is being read from (SPEC §13.1).
 *
 * The id **is** a path — `[...recordId]` takes the segments and this rejoins
 * exactly what the URL carried, because percent-encoding the slashes into one
 * segment is what a single `[recordId]` would have forced.
 *
 * A page reads through `db/queries`, never through the schema — see
 * `supplier-page.ts` for why.
 */
export async function loadRecordPage(
  db: Database,
  args: { programId: string; segments: string[] },
) {
  const recordId = args.segments.map(decodeURIComponent).join('/');

  const record = await db.query.record.findFirst({ where: eq(t.record.id, recordId) });
  if (!record) return undefined;

  const program = await db.query.program.findFirst({ where: eq(t.program.id, args.programId) });
  return { record, program };
}

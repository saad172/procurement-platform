import { eq } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as t from '@/db/schema';
import { PROGRAM } from '@/db/seed-data/program';

/**
 * The **approved** Program, by name (SPEC §4.3).
 *
 * It used to be `findFirst()` with no `orderBy`, which was unambiguous while
 * exactly one Program existed. The arranged-fixtures Program (SPEC §19.3) seeds
 * alongside it, so an unordered read began returning whichever row Postgres
 * reached first — and half the time that is `FIXTURE ARRANGEMENTS — test only`,
 * which is not a program anybody wants to land on.
 *
 * **The fix is a name, not an `ORDER BY`** — the same conclusion finding 81
 * reached when this bit the assess replay, and `tests/support/seeded-program.ts`
 * carries the other half of it. Ordering would make the answer stable; asking
 * for a specific Program makes it correct, and stays correct when a third one
 * arrives.
 */
export async function loadApprovedProgram(db: Database) {
  return db.query.program.findFirst({ where: eq(t.program.name, PROGRAM.name) });
}

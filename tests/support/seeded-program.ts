import { eq } from 'drizzle-orm';
import * as t from '@/db/schema';
import { PROGRAM } from '@/db/seed-data/program';
import type { TestDb } from './test-db';

/**
 * **The approved Program, by name.**
 *
 * Tests took `db.select().from(t.program).limit(1)` while there was only one
 * Program in the database. Then the arranged-fixtures Program (§19.3)
 * arrived, `resetDerived` correctly left it alone — it is authored data, not
 * derived — and `limit(1)` on an unordered query started returning whichever
 * row Postgres reached first.
 *
 * The assess replay failed on turn 1 with a prompt naming the wrong Program,
 * which reads as prompt drift and is nothing of the kind.
 *
 * Same class as finding 61: a query with no total order is a query whose answer
 * is an accident. Here the fix is not an `ORDER BY` but a **name** — there is a
 * specific Program meant, and asking for "any" was the mistake.
 */
export async function seededProgram(db: TestDb) {
  const program = await db.query.program.findFirst({ where: eq(t.program.name, PROGRAM.name) });
  if (!program) throw new Error(`the approved Program "${PROGRAM.name}" is not seeded`);
  return program;
}

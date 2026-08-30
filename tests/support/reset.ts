import { sql } from 'drizzle-orm';
import * as authored from '@/db/schema/authored';
import type { TestDb } from './test-db';

/**
 * Empties every **derived** table, leaving the authored ones seeded.
 *
 * ## Why a replay needs this
 *
 * A replay is a function of the database it starts from. The recorded run saw a
 * particular database, and the tool results in the fixture are answers about
 * *that* one — so a replay against a different state produces different tool
 * results, a different next request, and a miss.
 *
 * It surfaced as a suite that passed file-by-file and failed as a whole: the
 * resolve replay settles a Match for Yazaki, and the chat fixture's
 * `get_supplier` call for Yazaki then saw a Match where the recording had none.
 * Neither test was wrong; they were coupled through rows neither one mentions.
 *
 * ## Why the authored list is the exception list
 *
 * The schema's convention is that `src/db/seed.ts` writes the authored tables
 * and **nothing else writes to them** — so "everything not authored" is exactly
 * "everything a run can produce". Deriving the list from the authored module
 * rather than writing it out means a new derived table is covered the day it is
 * added, which is the opposite of how a hand-kept list ages.
 */
export async function resetDerived(db: TestDb): Promise<void> {
  const authoredTables = new Set(
    Object.values(authored)
      .map((table) => tableName(table))
      .filter((name): name is string => name != null),
  );

  const rows = await db.execute<{ tablename: string }>(sql`
    select tablename from pg_tables where schemaname = 'public'
  `);

  const derived = [...rows]
    .map((row) => row.tablename)
    .filter((name) => !authoredTables.has(name) && name !== '__drizzle_migrations');

  if (derived.length === 0) return;

  // One statement, so the foreign keys between derived tables never see a
  // half-emptied database. `restart identity` matters for nothing here and is
  // omitted; `cascade` is what makes the order irrelevant.
  await db.execute(sql.raw(`truncate table ${derived.map((n) => `"${n}"`).join(', ')} cascade`));
}

/** Drizzle keeps the SQL name on a symbol, not a field. */
function tableName(table: unknown): string | null {
  if (!table || typeof table !== 'object') return null;
  for (const symbol of Object.getOwnPropertySymbols(table)) {
    if (String(symbol).includes('Name')) {
      const value = (table as Record<symbol, unknown>)[symbol];
      if (typeof value === 'string') return value;
    }
  }
  return null;
}

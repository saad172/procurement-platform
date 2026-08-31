import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import * as schema from '@/db/schema';
import { seed } from '@/db/seed';
import { TEST_DATABASE_URL } from './test-db';

/**
 * Migrates **and seeds** the test database once, before any test file runs.
 *
 * Vitest runs files in parallel, so migrating per file raced on Drizzle's own
 * migrations table: two workers would each see an unapplied migration, both
 * would apply it, and one would fail on a duplicate object. The symptom was an
 * intermittently skipped suite rather than a red one, which is the worse
 * failure — a test that quietly does not run.
 *
 * **Seeding belongs here too.** It used to happen only inside
 * `seed-facts.test.ts`, which meant every other database-backed test depended
 * on that one file having run first — invisible while a developer's database
 * happened to be seeded already, and a fresh-container failure in CI. The seed
 * is idempotent, so `seed-facts.test.ts` calling it again costs nothing.
 *
 * ## Two failures that are not the same failure
 *
 * *Not up* is a legitimate state: every database-backed suite skips itself with
 * a hint naming the compose command, so a developer without Docker still gets a
 * useful run. **A database that is up and will not migrate or seed is not that**
 * — and swallowing it silently is what turns a broken test database into a
 * replay miss in an unrelated fixture, which reads as *"the fixture drifted"*
 * and sends the reader to re-record something that was never wrong. It has cost
 * two sessions an hour each.
 *
 * So the connection is probed on its own, and anything after it that fails is
 * reported. Reported rather than thrown: throwing here aborts the whole run,
 * including the ~500 tests that touch no database and would still have been
 * worth running.
 */
export default async function setup(): Promise<void> {
  let client: postgres.Sql | undefined;
  try {
    client = postgres(TEST_DATABASE_URL, { max: 1, connect_timeout: 3 });
    await client`select 1`;
  } catch {
    await client?.end();
    return;
  }

  try {
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: './src/db/migrations' });
    await seed(db);
  } catch (error) {
    console.error(
      [
        '',
        '  ✗ The test database is up but could not be migrated or seeded.',
        `    ${error instanceof Error ? error.message : String(error)}`,
        '',
        '    Database-backed suites will run against whatever state it is in,',
        '    which surfaces as failures that look like drifted fixtures and are',
        '    not. Drizzle keeps its migrations table in its OWN `drizzle`',
        '    schema, so dropping `public` alone leaves the migrator believing',
        '    every migration is applied. Drop both:',
        '',
        `      psql "${TEST_DATABASE_URL}" -c 'drop schema public cascade; create schema public; drop schema if exists drizzle cascade;'`,
        '',
      ].join('\n'),
    );
  } finally {
    await client.end();
  }
}

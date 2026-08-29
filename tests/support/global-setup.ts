import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { TEST_DATABASE_URL } from './test-db';

/**
 * Migrates the test database **once**, before any test file runs.
 *
 * Vitest runs files in parallel, so migrating per file raced on Drizzle's own
 * migrations table: two workers would each see an unapplied migration, both
 * would apply it, and one would fail on a duplicate object. The symptom was an
 * intermittently skipped suite rather than a red one, which is the worse
 * failure — a test that quietly does not run.
 */
export default async function setup(): Promise<void> {
  let client: postgres.Sql | undefined;
  try {
    client = postgres(TEST_DATABASE_URL, { max: 1, connect_timeout: 3 });
    await client`select 1`;
    await migrate(drizzle(client), { migrationsFolder: './src/db/migrations' });
  } catch {
    // Not up. Every database-backed suite skips itself with a hint naming the
    // compose command, so this is a legitimate state rather than a failure.
  } finally {
    await client?.end();
  }
}

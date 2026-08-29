import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import * as schema from '@/db/schema';

/**
 * A second database on the compose project, migrated by the same migrator the
 * app uses (SPEC §19.1). Tests that touch rows run against it.
 *
 * Deliberately the real Postgres rather than an in-memory stand-in: half the
 * guarantees this build relies on are `CHECK` constraints and foreign keys, and
 * a fake would not have them.
 */

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://procurement:procurement@localhost:5545/procurement_test';

export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

let client: postgres.Sql | undefined;
let db: TestDb | undefined;

/** Skips the suite with a readable reason when the test database is not up. */
export async function testDatabaseIsUp(): Promise<boolean> {
  try {
    const probe = postgres(TEST_DATABASE_URL, { max: 1, connect_timeout: 2 });
    await probe`select 1`;
    await probe.end();
    return true;
  } catch {
    return false;
  }
}

export async function getTestDb(): Promise<TestDb> {
  if (!db) {
    client = postgres(TEST_DATABASE_URL, { max: 4 });
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: './src/db/migrations' });
  }
  return db;
}

export async function closeTestDb(): Promise<void> {
  await client?.end();
  client = undefined;
  db = undefined;
}

/** Raw tagged-template access, for asserting on constraints directly. */
export function testSql(): postgres.Sql {
  if (!client) throw new Error('call getTestDb() first');
  return client;
}

export const START_TEST_DB_HINT =
  'docker compose -f docker-compose.yml -f docker-compose.test.yml up -d postgres-test';

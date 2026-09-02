import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { loadEnv } from '@/config/env';
import * as schema from './schema';

/**
 * Two connections, because Supabase fronts Postgres with Supavisor (SPEC §4.1).
 *
 *   pooled  — the transaction pooler. Used by the Next.js server components and
 *             route handlers, where connections are many and short-lived.
 *             Drizzle over postgres.js must set `prepare: false`: the
 *             transaction pooler does not hold a session, so a prepared
 *             statement named on one connection is not there on the next.
 *
 *   direct  — a session connection. Used by migrations, the seed, and the
 *             worker, whose `FOR UPDATE SKIP LOCKED` dequeue needs a real
 *             transaction held across statements.
 *
 * Locally both URLs point at the same Docker Postgres, so the split costs
 * nothing in development and is correct in the one place it matters.
 */

export type Database = ReturnType<typeof drizzle<typeof schema>>;

let pooledDb: Database | undefined;
let pooledClient: postgres.Sql | undefined;
let directDb: Database | undefined;
let directClient: postgres.Sql | undefined;

/** For the web process: pooled, prepare-less, many short connections. */
export function getPooledDb(): Database {
  if (!pooledDb) {
    const env = loadEnv();
    pooledClient = postgres(env.DATABASE_URL, {
      prepare: false,
      max: 10,
    });
    pooledDb = drizzle(pooledClient, { schema });
  }
  return pooledDb;
}

/** For the worker, migrations and the seed: a real session connection. */
export function getDirectDb(): Database {
  if (!directDb) {
    const env = loadEnv();
    directClient = postgres(env.DIRECT_DATABASE_URL, {
      max: env.WORKER_CONCURRENCY + 2,
    });
    directDb = drizzle(directClient, { schema });
  }
  return directDb;
}

/** Lets the worker and one-shot scripts exit cleanly instead of hanging. */
export async function closeDirectDb(): Promise<void> {
  await directClient?.end();
  directClient = undefined;
  directDb = undefined;
}

/**
 * The same courtesy for the pooled connection, which only a test ever needs.
 *
 * The web process holds it for its whole life, so nothing there closes it. A
 * test that exercises a route handler opens it in-process, and ten idle
 * connections are enough to keep a runner from exiting.
 */
export async function closePooledDb(): Promise<void> {
  await pooledClient?.end();
  pooledClient = undefined;
  pooledDb = undefined;
}

export { schema };

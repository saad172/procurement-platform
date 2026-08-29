// Next.js loads `.env` itself; a plain Node entrypoint has to ask.
import 'dotenv/config';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { closeDirectDb, getDirectDb } from './client';
import { loadEnv } from '@/config/env';

/**
 * The one-shot `migrate` service in docker compose, and `pnpm db:migrate`
 * online. Both web and worker `depends_on` this completing successfully, so a
 * process never starts against a schema it does not understand (SPEC §4).
 */
async function main(): Promise<void> {
  loadEnv();
  const db = getDirectDb();
  console.log('Applying migrations…');
  await migrate(db, { migrationsFolder: './src/db/migrations' });
  console.log('Migrations applied.');
  await closeDirectDb();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

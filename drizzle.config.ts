import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

/**
 * Migrations run against DIRECT_DATABASE_URL, never the pooler: DDL needs a
 * session, and the transaction pooler does not hold one (SPEC §4.1).
 */
export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DIRECT_DATABASE_URL ?? '',
  },
  strict: true,
  verbose: true,
});

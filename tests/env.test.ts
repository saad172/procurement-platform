import { describe, expect, it, beforeEach } from 'vitest';
import { loadEnv, resetEnvForTesting, type EnvSource } from '@/config/env';

/**
 * SPEC §4.2: a missing credential refuses to boot, naming what is absent and
 * where it comes from. The test asserts the *refusal*, not the happy path —
 * booting successfully is proved by every other test running.
 */

const COMPLETE = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  DIRECT_DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  SAYARI_CLIENT_ID: 'id',
  SAYARI_CLIENT_SECRET: 'secret',
  ANTHROPIC_API_KEY: 'key',
} satisfies EnvSource;

describe('loadEnv', () => {
  beforeEach(() => resetEnvForTesting());

  it('accepts a complete environment and applies the documented defaults', () => {
    const env = loadEnv({ ...COMPLETE });
    expect(env.WORKER_CONCURRENCY).toBe(4);
    expect(env.DOSSIER_ENABLED).toBe(false);
  });

  it('refuses to boot without Sayari credentials, and says where they come from', () => {
    const { SAYARI_CLIENT_ID: _id, SAYARI_CLIENT_SECRET: _secret, ...rest } = COMPLETE;
    expect(() => loadEnv(rest)).toThrowError(/Sayari: SAYARI_CLIENT_ID, SAYARI_CLIENT_SECRET/);
    resetEnvForTesting();
    expect(() => loadEnv(rest)).toThrowError(/OAuth2 client credentials/);
  });

  it('refuses a database URL that is not a postgres connection string', () => {
    expect(() => loadEnv({ ...COMPLETE, DATABASE_URL: 'mysql://nope' })).toThrowError(
      /Database: DATABASE_URL/,
    );
  });

  it('names every absent tier at once rather than one per attempt', () => {
    expect(() => loadEnv({})).toThrowError(/Database:[\s\S]*Sayari:[\s\S]*Anthropic:/);
  });
});

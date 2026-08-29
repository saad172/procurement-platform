import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    // Migrates the test database once, before any file runs.
    globalSetup: ['tests/support/global-setup.ts'],

    /**
     * Test FILES run one at a time.
     *
     * Several database-backed files insert into tables that are global rather
     * than per-fixture — `criterion`, `tariff_flag` — with
     * `ON CONFLICT DO NOTHING`. Run in parallel, two files racing on the same
     * upsert produced an intermittent single-test failure that passed on every
     * re-run, which is the worst kind: it reads as flaky infrastructure and
     * trains you to re-run rather than look.
     *
     * The whole suite takes about a second, so serialising costs nothing worth
     * measuring against a class of failure it removes entirely.
     */
    fileParallelism: false,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});

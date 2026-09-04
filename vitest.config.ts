import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    // Migrates the test database once, before any file runs.
    globalSetup: ['tests/support/global-setup.ts'],

    /**
     * Vitest's own 5000ms default. Every DB-backed test in this suite runs
     * comfortably inside that on a local machine, but GitHub Actions' shared
     * runners are slower and noisier — the same suite that passes locally
     * every time timed out on routine Postgres round-trips in CI specifically
     * (`testDatabaseIsUp()` itself, not application logic). Raised well past
     * what CI has actually needed, and still nowhere near the job-level
     * 15-minute ceiling in `.github/workflows/ci.yml`, so a genuine hang is
     * still caught — this isn't a masked timeout, it's a realistic one.
     */
    testTimeout: 30000,
    hookTimeout: 30000,

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

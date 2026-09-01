import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import tseslint from 'typescript-eslint';

/**
 * Three of the four structural chokepoints in SPEC §2.4 are import boundaries
 * rather than tests, because the mistake each one prevents is *a file added
 * later without thinking about it* — which no amount of iterating over runtime
 * values can see.
 *
 *   src/upstream/**  is the only place that may reach an upstream service.
 *                    Enforcing it makes "spent an upstream credit without
 *                    caching it" unrepresentable: the one function that can
 *                    spend is also the one that writes `upstream_response`.
 *
 *   src/model/**     is the only place that may construct an Anthropic client.
 *                    Same shape: the one function that can call a model is also
 *                    the one that writes `trace_turn` and `usage_event`.
 *
 *   src/tools/**     may not reach the Match settlement module. The agents
 *                    propose and our code settles, so no tool on any surface
 *                    can write `match.status` or `match.entity_id`.
 *
 * The fourth chokepoint, `finalizeRegistry()`, is a boot check rather than a
 * lint rule — it quantifies over runtime values (per-surface and per-Round tool
 * lists), which a linter cannot see.
 */
const SAYARI = { group: ['@sayari/sdk', '@sayari/sdk/*'], message: 'Only src/upstream/** may import @sayari/sdk. Every call through src/upstream/call() is cached, metered and traced; a call around it is not. See SPEC §2.4.' };
const ANTHROPIC = { group: ['@anthropic-ai/sdk', '@anthropic-ai/sdk/*'], message: 'Only src/model/** may import @anthropic-ai/sdk. Every call through src/model/runLoop() writes a trace_turn and a usage_event; a call around it is not counted. See SPEC §2.4.' };
const SETTLE_MATCH = { group: ['**/domain/match/settle-match', '@/domain/match/settle-match'], message: 'The agents propose and our code settles. No tool on any surface writes match.status or match.entity_id. See SPEC §15.4.' };

const NO_OUTBOUND_FETCH = [
  'error',
  {
    name: 'fetch',
    message:
      'Outbound fetch belongs in src/upstream/call(), which caches the body and writes a usage_event. See SPEC §2.4.',
  },
];

/**
 * One complete block per directory, rather than several partial blocks that
 * overlap. `no-restricted-imports` is a single rule: a later block setting it
 * REPLACES an earlier one for any file matching both, so a partial block is a
 * silently disabled boundary. Listing every restriction that applies to a
 * directory in one place is what makes each block readable on its own.
 */
export default tseslint.config(
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'next-env.d.ts',
      'src/db/migrations/**',
      // Planning-era material, kept as a dated record rather than as app code.
      'docs/research/probe/**',
      '.scratch/**',
    ],
  },

  ...nextCoreWebVitals,
  ...tseslint.configs.recommended,

  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      // `any` erases the guarantees the zod projections in src/upstream exist to
      // provide, so it is an error rather than a warning.
      '@typescript-eslint/no-explicit-any': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  // ── Everything that is neither chokepoint ─────────────────────────────────
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/upstream/**', 'src/model/**', 'src/tools/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [SAYARI, ANTHROPIC] }],
      'no-restricted-globals': NO_OUTBOUND_FETCH,
    },
  },

  // ── Chokepoint 1: src/upstream may reach an upstream service ──────────────
  // It may import the Sayari SDK and call fetch — that is its whole job. It may
  // not construct an Anthropic client.
  {
    files: ['src/upstream/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [ANTHROPIC] }],
    },
  },

  // ── Chokepoint 2: src/model may construct an Anthropic client ─────────────
  {
    files: ['src/model/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [SAYARI] }],
      'no-restricted-globals': NO_OUTBOUND_FETCH,
    },
  },

  /**
   * Client components may `fetch` their own origin.
   *
   * The upstream boundary guards ONE thing: spending an upstream credit without
   * caching it. A file marked `'use client'` runs in the browser, which holds no
   * Sayari credentials and could not reach Sayari if it tried — so a same-origin
   * `fetch('/api/chat')` is categorically outside what the rule protects.
   *
   * The import restrictions still apply here, because a client component
   * importing the Sayari SDK would be a different and much worse mistake.
   */
  {
    files: ['src/components/**/*.tsx'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [SAYARI, ANTHROPIC] }],
      'no-restricted-globals': 'off',
    },
  },

  // ── Chokepoint 3: no tool may reach Match settlement ──────────────────────
  {
    files: ['src/tools/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [SAYARI, ANTHROPIC, SETTLE_MATCH] }],
      'no-restricted-globals': NO_OUTBOUND_FETCH,
    },
  },

  /**
   * ── One owner for run and job state ──────────────────────────────────────
   *
   * Not one of SPEC §2.4's four. It was added after the UI turned out to be a
   * second owner of the Job state machine: `retryJob` and `retryRun` each
   * carried the same eight-field requeue payload verbatim, and `run-actions.ts`
   * had grown its own `resumeRun` that disagreed with the one in `jobs/runs.ts`
   * about money — `remaining?.n ?? 1` added $3 for a Supplier that did not
   * exist, at two decimals against the other's four.
   *
   * This is the `settleMatch()` argument applied to a Run: the agents propose
   * and our code settles, and a page proposes rather than settles too.
   *
   * A syntax rule rather than an import boundary, because the schema is one
   * module — `src/db/schema` — that every reader legitimately imports. What is
   * restricted is the *write*, not the import.
   */
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/jobs/runs.ts', 'src/db/seed.ts', 'src/db/seed-test-program.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.property.name=/^(update|insert|delete)$/][arguments.0.object.name='t'][arguments.0.property.name=/^(job|run)$/]",
          message:
            'Only src/jobs/runs.ts may write the job and run tables. openRun, enqueueJob, dequeueJob, finishJob, requeueJobs, cancelRun, resumeRun and settleRunState are the whole state machine; a second writer is how two retry paths came to hold the same payload and two resume paths came to disagree about money.',
        },
      ],
    },
  },

  /**
   * ── A page reads through `db/queries`, never through the schema ───────────
   *
   * Eleven of thirteen pages ran drizzle inline while `db/queries` already held
   * nineteen `loadX()` functions, and nothing said which a new page should use
   * — so the answer was whichever the last person had copied. Two ways to read
   * the same rows, and the only way to tell which a page used was to open it.
   *
   * Types are allowed through. `charts.tsx` and `supplier-table.tsx` take
   * `typeof t.supplier.$inferSelect` for their props, which is the schema used
   * as a vocabulary rather than as a database — it emits no query and cannot
   * lose a `where` clause.
   *
   * Server actions and route handlers are deliberately not covered: they write,
   * and what they may write is the rule above this one.
   */
  {
    files: ['src/app/**/page.tsx'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@/db/schema',
              allowTypeImports: true,
              message:
                'A page renders; db/queries reads. Put the query in src/db/queries as a named loadX() and call it here — that is what makes a page you can change without re-deriving what it fetches. Importing the schema for a type is fine: use `import type`.',
            },
          ],
        },
      ],
    },
  },

  // The worker, the seed, the migrator and the scripts are processes whose log
  // output IS their user interface, so `console` is the right call there.
  {
    files: [
      'tests/**/*.ts',
      'scripts/**/*.ts',
      'src/db/seed.ts',
      'src/db/migrate.ts',
      'src/worker/**/*.ts',
    ],
    rules: {
      'no-console': 'off',
    },
  },
);

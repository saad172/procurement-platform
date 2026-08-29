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

  // ── Chokepoint 3: no tool may reach Match settlement ──────────────────────
  {
    files: ['src/tools/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [SAYARI, ANTHROPIC, SETTLE_MATCH] }],
      'no-restricted-globals': NO_OUTBOUND_FETCH,
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

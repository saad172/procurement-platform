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
const UPSTREAM_ONLY_PACKAGES = ['@sayari/sdk'];
const MODEL_ONLY_PACKAGES = ['@anthropic-ai/sdk'];

const boundary = (packages, allowedDir) => ({
  name: `no-${packages.join('-')}-outside-${allowedDir}`,
  patterns: packages.map((pkg) => ({
    group: [pkg, `${pkg}/*`],
    message: `Only ${allowedDir} may import ${pkg}. See SPEC §2.4 — the chokepoint exists so every call through it is cached, metered and traced.`,
  })),
});

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

  // ── Chokepoint 1: only src/upstream may reach an upstream service ─────────
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/upstream/**'],
    rules: {
      'no-restricted-imports': ['error', boundary(UPSTREAM_ONLY_PACKAGES, 'src/upstream/**')],
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message:
            'Outbound fetch belongs in src/upstream/call(), which caches the body and writes a usage_event. See SPEC §2.4.',
        },
      ],
    },
  },

  // ── Chokepoint 2: only src/model may construct an Anthropic client ────────
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/model/**'],
    rules: {
      'no-restricted-imports': ['error', boundary(MODEL_ONLY_PACKAGES, 'src/model/**')],
    },
  },

  // Both boundaries apply to most of the tree, and the two config blocks above
  // would otherwise overwrite each other's `no-restricted-imports`. This block
  // restates them together for the files that are outside both directories.
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/upstream/**', 'src/model/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...boundary(UPSTREAM_ONLY_PACKAGES, 'src/upstream/**').patterns,
            ...boundary(MODEL_ONLY_PACKAGES, 'src/model/**').patterns,
          ],
        },
      ],
    },
  },

  // ── Chokepoint 3: no tool may reach Match settlement ──────────────────────
  {
    files: ['src/tools/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...boundary(UPSTREAM_ONLY_PACKAGES, 'src/upstream/**').patterns,
            ...boundary(MODEL_ONLY_PACKAGES, 'src/model/**').patterns,
            {
              group: ['**/domain/match/settle-match', '@/domain/match/settle-match'],
              message:
                'The agents propose and our code settles. No tool on any surface writes match.status or match.entity_id. See SPEC §15.4.',
            },
          ],
        },
      ],
    },
  },

  // The worker, the seed and the migrator are processes whose log output IS
  // their user interface, so `console` is the right call there.
  {
    files: ['tests/**/*.ts', 'src/db/seed.ts', 'src/db/migrate.ts', 'src/worker/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
);

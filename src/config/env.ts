import { z } from 'zod';

/**
 * Boot-time environment validation (SPEC §4.2).
 *
 * A missing credential refuses to boot, naming what is absent and where it
 * comes from. There is no degraded mode: the app has no committed snapshot of
 * results to fall back to, so "start anyway and fail later" would only move the
 * error somewhere less legible.
 *
 * Variables are grouped into tiers so the error message can say which *set* is
 * missing rather than listing bare names — "Sayari credentials" is actionable
 * in a way that "SAYARI_CLIENT_SECRET" alone is not.
 *
 * Deliberately NOT here: an `UPSTREAM=live|cache` mode flag. Absent credentials
 * is a constructor argument used by tests, never an environment mode the
 * running app honours (SPEC §4.2, §19.1).
 */

const postgresUrl = z
  .string()
  .min(1)
  .refine((value) => value.startsWith('postgres://') || value.startsWith('postgresql://'), {
    message: 'must be a postgres:// or postgresql:// connection string',
  });

const booleanish = z
  .string()
  .optional()
  .transform((value) => value === 'true' || value === '1');

const positiveInt = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined || value === '' ? fallback : Number(value)))
    .pipe(z.number().int().positive());

/** Each tier names where its variables come from, for the boot error message. */
const TIERS = {
  database: {
    label: 'Database',
    source: 'docker compose (local) or the Supabase project settings (online)',
    keys: ['DATABASE_URL', 'DIRECT_DATABASE_URL'],
  },
  sayari: {
    label: 'Sayari',
    source: 'your Sayari account — OAuth2 client credentials',
    keys: ['SAYARI_CLIENT_ID', 'SAYARI_CLIENT_SECRET'],
  },
  anthropic: {
    label: 'Anthropic',
    source: 'https://console.anthropic.com — API keys',
    keys: ['ANTHROPIC_API_KEY'],
  },
} as const;

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // Database — SPEC §4.1
  DATABASE_URL: postgresUrl,
  DIRECT_DATABASE_URL: postgresUrl,

  // Sayari — the entity graph, trade data, negative news, ownership traversal
  SAYARI_CLIENT_ID: z.string().min(1),
  SAYARI_CLIENT_SECRET: z.string().min(1),

  // Anthropic — presence only, never validity (SPEC §22.2 item 22)
  ANTHROPIC_API_KEY: z.string().min(1),

  // Optional
  MCP_BEARER: z.string().optional(),
  DOSSIER_ENABLED: booleanish,
  NOMINATIM_USER_AGENT: z.string().min(1).default('procurement-platform/0.1'),
  WORKER_CONCURRENCY: positiveInt(4),
  WORKER_POLL_INTERVAL_MS: positiveInt(1000),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Deliberately looser than `NodeJS.ProcessEnv`, which declares `NODE_ENV` as
 * required. Tests supply partial environments on purpose — proving the refusal
 * is the point of the test — so the parameter accepts any string map.
 */
export type EnvSource = Record<string, string | undefined>;

/**
 * Turns a zod failure into the sentence SPEC §4.2 asks for: what is absent, and
 * where it comes from.
 */
function describeFailure(issues: z.core.$ZodIssue[]): string {
  const missing = new Set(issues.map((issue) => String(issue.path[0])));

  const lines: string[] = ['Refusing to boot — the environment is incomplete.', ''];

  for (const tier of Object.values(TIERS)) {
    const absent = tier.keys.filter((key) => missing.has(key));
    if (absent.length === 0) continue;
    lines.push(`  ${tier.label}: ${absent.join(', ')}`);
    lines.push(`    from ${tier.source}`);
  }

  const untiered = [...missing].filter(
    (key) => !Object.values(TIERS).some((tier) => (tier.keys as readonly string[]).includes(key)),
  );
  if (untiered.length > 0) {
    lines.push(`  Other: ${untiered.join(', ')}`);
  }

  lines.push('', '  Copy .env.example to .env and fill in the blanks.');
  return lines.join('\n');
}

let cached: Env | undefined;

/**
 * Reads and validates the environment once per process.
 *
 * Call this at every entrypoint (the worker's main, the Next.js instrumentation
 * hook) so a misconfigured deployment fails at start rather than on the first
 * request that happens to need a credential.
 */
export function loadEnv(source: EnvSource = process.env): Env {
  if (cached) return cached;

  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(describeFailure(parsed.error.issues));
  }

  cached = parsed.data;
  return cached;
}

/** Test seam: forget the cached environment so a test can supply its own. */
export function resetEnvForTesting(): void {
  cached = undefined;
}

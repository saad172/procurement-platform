import { createHash } from 'node:crypto';

/**
 * The cache key (SPEC §16.2).
 *
 * `params_hash` is sha256 over canonical JSON of `{endpoint, params}` with keys
 * sorted at every level.
 *
 * **Defaults are applied before hashing**, by the caller, and that ordering is
 * the decision: it makes changing a default a *deliberate cache miss* rather
 * than an invisible one. If defaults were applied after, two requests that
 * differ in what the server actually received would collide on one key, and the
 * cached body would answer a question the new request did not ask.
 */

/** Recursively sorts object keys so two equal params hash identically. */
function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonicalise(v)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalise(value));
}

export function hashParams(endpoint: string, params: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson({ endpoint, params })).digest('hex');
}

/** Lets a changed body be noticed even when the params are identical. */
export function hashBody(body: unknown): string {
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

/** Canonical params as stored, so a cache miss can print what it looked for. */
export function canonicalParams(params: Record<string, unknown>): Record<string, unknown> {
  return canonicalise(params) as Record<string, unknown>;
}

import { createHash } from 'node:crypto';
import { canonicalJson } from '@/lib/canonical-json';

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

export { canonicalJson };

export function hashParams(endpoint: string, params: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson({ endpoint, params })).digest('hex');
}

/** Lets a changed body be noticed even when the params are identical. */
export function hashBody(body: unknown): string {
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

/** Canonical params as stored, so a cache miss can print what it looked for. */
export function canonicalParams(params: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(canonicalJson(params)) as Record<string, unknown>;
}

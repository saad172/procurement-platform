/**
 * Canonical JSON — the one stable serialisation both chokepoints hash against.
 *
 * `src/upstream` uses it for the cache key; `src/model` uses it for the wire
 * hash a replay matches on. Two implementations would eventually disagree about
 * key order or `undefined`, and a hash that disagrees with itself is worse than
 * no hash: it produces cache misses and replay misses that look like drift.
 *
 * It lives here rather than in either chokepoint because an import boundary
 * stops `src/model` reaching into `src/upstream` — correctly, since one of them
 * spends Sayari credits.
 */

/** Recursively sorts object keys so two equal values serialise identically. */
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

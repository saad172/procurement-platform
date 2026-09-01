/**
 * The two Sayari paths return different key casing, and the projection has to
 * be **identical on both** (SPEC §16.2).
 *
 * The SDK deserialises into camelCase (`entityId`, `psaCount`, `sourceCount`,
 * `possiblySameAs`); the raw-fetch fallback returns the API's own snake_case
 * (`entity_id`, `psa_count`, …). A projection written for one silently reads
 * `undefined` on the other — and because every field in a lenient projection is
 * nullish, it reads `undefined` *without failing*. That is the worst possible
 * shape for a bug: `psaCount` quietly becoming null would have made every Twin
 * invisible to Ownership exposure, and nothing would have gone red.
 *
 * So the body is normalised to snake_case before projecting. The **cached body
 * stays verbatim** — normalisation happens at projection time, not on the way
 * into `upstream_response` — because the cache's job is to hold what the
 * upstream actually said.
 *
 * Applied to Sayari only. The four external sources have their own native
 * conventions (GLEIF's `legalName`, the World Bank's `countryiso3code`), and
 * their projections match those directly.
 */

const camelToSnake = (key: string): string =>
  key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();

export function snakeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snakeKeys);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value;

  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const converted = camelToSnake(key);
    // An existing snake_case key wins over a converted one, so a payload
    // carrying both `matchStrength` and `match_strength` does not lose the
    // original to its own translation.
    if (converted !== key && Object.hasOwn(value as object, converted)) {
      out[key] = snakeKeys(raw);
      continue;
    }
    out[converted] = snakeKeys(raw);
  }
  return out;
}

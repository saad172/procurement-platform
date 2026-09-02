/**
 * Narrowing predicates and formatters for a frozen chat-widget payload,
 * shared by the widgets that hand-parse rather than declare a zod schema —
 * `entity_card`, `record_card`, `supplier_card`, `supplier_family`,
 * `source_result`, `trace_timeline` and `usage_meter` (each a raw database
 * row or a `JSON.parse` of stored text, not one shape a `z.object` can name
 * once). No JSX here: a component that wants to draw with these results
 * imports `figures.tsx` alongside this file.
 *
 * A frozen payload is `unknown` (SPEC §14.4): it was JSON read back from
 * `thread_message.widget`, so a date is a string and a field a renderer wants
 * may be missing from a payload frozen before this file existed. Every helper
 * here is a narrowing check or a formatter, never a thrower — the caller
 * always has a fallback to fall back to.
 */

export function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

export function str(x: unknown): string | null {
  return typeof x === 'string' ? x : null;
}

export function num(x: unknown): number | null {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

export function bool(x: unknown): boolean {
  return x === true;
}

export function arr(x: unknown): unknown[] {
  return Array.isArray(x) ? x : [];
}

/** `2026-08-31T14:01:44.277Z` → `2026-08-31`. Never throws on a bad string. */
export function isoDate(x: unknown): string {
  const s = str(x);
  if (!s) return '—';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '—' : d.toISOString().slice(0, 10);
}

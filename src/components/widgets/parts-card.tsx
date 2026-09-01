import type { ReactNode } from 'react';

/**
 * Small, shared helpers for the seven widgets below.
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

/**
 * The `.where` figure grid (SPEC §13.1's answer strip, `globals.css` `.where`).
 *
 * One shape, three call sites: a supplier card, a family widget and a usage
 * meter all show a row of plain figures labelled in a buyer's words, and this
 * is the one component that draws that row.
 */
export function WhereGrid({
  items,
}: {
  items: { value: ReactNode; label: ReactNode; tone?: 'good' | 'warn' | 'bad' }[];
}) {
  return (
    <div className="where" style={{ margin: '0.4rem 0' }}>
      {items.map((item, i) => (
        <div key={i} className={item.tone ?? ''}>
          <b>{item.value}</b>
          <span>{item.label}</span>
        </div>
      ))}
    </div>
  );
}

/** `settled by agents` / `agreed by the checks alone` — the Supplier page's own words. */
export function settledByLine(settledBy: string): string {
  if (settledBy === 'rules') return 'agreed by the checks alone, with no model involved';
  if (settledBy === 'agents') return 'two independent reads agreed on it';
  if (settledBy === 'person') return 'a person decided this';
  return settledBy;
}

import type { ReactNode } from 'react';

/**
 * The `.where` figure grid (SPEC §13.1's answer strip, `globals.css` `.where`)
 * — a row of plain figures labelled in a buyer's words, the same shape every
 * page's own `.where` block draws.
 *
 * `usage_meter` is the one widget that draws it today. `supplier_card` and
 * `supplier_family` show a comparable row of figures inside a `<table>`
 * instead, because their rows carry more per figure than this grid's plain
 * `<b>`/`<span>` pair has room for — a link, a badge, a per-member breakdown
 * — so folding them into `WhereGrid` would either drop that detail or grow
 * this component a second, more complicated shape beside the plain one.
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

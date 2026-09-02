import Link from 'next/link';
import { z } from 'zod/v4';
import { hsLineBadge } from '@/domain/category-answer';
import { RawPayload } from './raw';

/**
 * `category_summary` — the Category page's heading plus its Tariff table
 * (`src/app/program/[programId]/category/[categoryId]/sections.tsx`, the
 * `<span className="term">What it costs to bring in<i>Tariff</i></span>`
 * card), the level `Category → Supplier` sits below in the spine (SPEC
 * §13.1).
 *
 * `get_category`'s query loads `flags` as bare `category_flag` rows, never
 * joined to `tariff_flag` for a label or a `whyNotARate` (finding 103), and
 * it names no bidder at all despite its own description promising one — so
 * this widget draws the flag key it actually has and omits a bidder count
 * rather than fetching one behind the payload's back.
 */

const hsLineSchema = z.object({
  id: z.string(),
  hsCode: z.string(),
  label: z.string(),
  rate: z.union([z.string(), z.number()]),
  isDefault: z.boolean(),
});
const flagSchema = z.object({ flagKey: z.string(), note: z.string().nullable().optional() });
const payloadSchema = z.object({
  id: z.string(),
  programId: z.string(),
  code: z.string(),
  name: z.string(),
  note: z.string().nullable().optional(),
  hsLines: z.array(hsLineSchema),
  flags: z.array(flagSchema),
});

export function CategorySummaryWidget({ payload }: { payload: unknown }) {
  const parsed = payloadSchema.safeParse(payload);
  // Falls back rather than throws: a widget frozen onto a message outlives
  // the shape this schema names (finding 103).
  if (!parsed.success) return <RawPayload payload={payload} />;
  const c = parsed.data;
  return (
    <div>
      <h4 style={{ margin: '0 0 0.3rem' }}>
        <Link href={`/program/${c.programId}/category/${c.id}` as never}>
          <span className="mono">{c.code}</span> {c.name}
        </Link>
      </h4>
      {c.note ? (
        <p className="note" style={{ margin: '0 0 0.5rem' }}>
          {c.note}
        </p>
      ) : null}
      <HsLineTable lines={c.hsLines} />
      <FlagBadges flags={c.flags} />
    </div>
  );
}

/**
 * ── HS lines, the scored one marked apart from every candidate one ──
 *
 * `isDefault` names the one line `tariffExposure` reads; the rest are shown
 * because a buyer might import the same part under a different code, not
 * because they count. `hsLineBadge()` (`@/domain/category-answer`) is the
 * page's own rule for the badge, so "scored" cannot come to mean something
 * different here than it does on the page.
 */
function HsLineTable({ lines }: { lines: z.infer<typeof hsLineSchema>[] }) {
  if (lines.length === 0) return <p className="empty">No HS lines recorded.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>HS code</th>
          <th>Label</th>
          <th className="num">Base duty</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {lines.map((l) => (
          <tr key={l.id}>
            <td className="mono">{l.hsCode}</td>
            <td>{l.label}</td>
            <td className="num">{Number(l.rate)}%</td>
            <td>
              <span className={`badge ${l.isDefault ? '' : 'mute'}`}>
                {hsLineBadge(l.isDefault)}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Trade-action flags, named by their bare key: `get_category` never joins `tariff_flag` for a label (finding 103), so the key is what there is. */
function FlagBadges({ flags }: { flags: z.infer<typeof flagSchema>[] }) {
  if (flags.length === 0) return null;
  return (
    <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
      {flags.map((f) => (
        <span key={f.flagKey} className="badge warn" title={f.note ?? undefined}>
          {f.flagKey.replace(/_/g, ' ')}
        </span>
      ))}
    </div>
  );
}

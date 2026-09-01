import Link from 'next/link';
import { z } from 'zod/v4';
import { RawPayload } from './raw';

/**
 * `category_summary` — mirrors the Category page heading: name, code, HS
 * lines and trade-action flags.
 *
 * `get_category`'s query loads `flags` as bare `category_flag` rows, never
 * joined to `tariff_flag` for a label or a `whyNotARate`, and it names no
 * bidder at all despite its own description promising one — so this widget
 * draws the flag key it actually has and omits bidders rather than fetching
 * behind the payload's back.
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
              {l.isDefault ? (
                <span className="badge">scored</span>
              ) : (
                <span className="badge mute">candidate</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

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

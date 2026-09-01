import Link from 'next/link';
import { z } from 'zod/v4';
import { RawPayload } from './raw';

/**
 * `needs_review_list` — mirrors the Needs Review index: roster row, where
 * the roster says it is, and how it is waiting.
 *
 * `list_needs_review` joins only `supplier` and `match` — no `candidateCount`
 * the way the page's own loader counts them — so this widget names how a row
 * is waiting without a number it was never handed. `match.settledAt` is the
 * only timestamp on the row; for a Match still parked it reads as *since*.
 */

const rowSchema = z.object({
  supplier: z.object({
    id: z.string(),
    programId: z.string(),
    rosterIndex: z.number().nullable(),
    rosterName: z.string().nullable(),
    rosterAddress: z.string().nullable(),
    rosterCountry: z.string().nullable(),
  }),
  match: z.object({ status: z.string(), settledAt: z.string(), settledBy: z.string() }),
});
const payloadSchema = z.array(rowSchema);

export function NeedsReviewListWidget({ payload }: { payload: unknown }) {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) return <RawPayload payload={payload} />;
  const rows = parsed.data;
  if (rows.length === 0) return <p className="note">Nothing is waiting on a decision.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th className="num">Row</th>
          <th>Supplier</th>
          <th>Where the roster says it is</th>
          <th>Since</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ supplier: s, match: m }) => (
          <tr key={s.id}>
            <td className="num">{s.rosterIndex ?? '—'}</td>
            <td>
              <Link href={`/program/${s.programId}/needs-review/${s.id}` as never}>
                {s.rosterName ?? s.id}
              </Link>
              <div className="note">
                <span className={`badge ${m.status === 'needs_review' ? 'warn' : 'bad'}`}>
                  {m.status.replace(/_/g, ' ')}
                </span>
              </div>
            </td>
            <td className="note">
              {s.rosterAddress ?? '—'} · {s.rosterCountry ?? '—'}
            </td>
            <td className="note">{new Date(m.settledAt).toLocaleDateString('en-US')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

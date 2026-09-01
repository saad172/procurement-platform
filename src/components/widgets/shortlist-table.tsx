import { z } from 'zod/v4';
import { RawPayload } from './raw';
import {
  CRITERION_LABELS,
  WEIGHTED_CRITERIA,
  confidenceTone,
  coverageNote,
  fmtScore,
} from './parts-table';

/**
 * `shortlist_table` — the Category page's Shortlist in miniature, plus the
 * weight vector rendered as a row of six labelled weights (SPEC §14.4): the
 * freeze is legible, not merely true.
 *
 * `get_shortlist`'s widget payload carries no `programId` and no
 * `categoryId` — only `category`, the name — so a Supplier here is named,
 * never linked; guessing the Program from the page a chat is open on would
 * point a citation-adjacent figure at the wrong row on a wrong turn.
 */

const rowSchema = z.object({
  rank: z.number().nullable(),
  supplierId: z.string(),
  displayName: z.string(),
  score: z.number().nullable(),
  coverage: z.object({ computed: z.number(), total: z.number() }),
  dataConfidence: z.string(),
  disqualifying: z.boolean(),
  disqualifyingFactors: z.array(z.string()).optional(),
  visible: z.boolean().optional(),
});
const payloadSchema = z.object({
  category: z.string(),
  whatIf: z.boolean(),
  weights: z.record(z.string(), z.number()),
  ranked: z.array(rowSchema),
  excluded: z.array(z.object({ row: rowSchema, reason: z.string() })),
  visibleCount: z.number(),
  totalCount: z.number(),
});
type Row = z.infer<typeof rowSchema>;

export function ShortlistTableWidget({ payload }: { payload: unknown }) {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) return <RawPayload payload={payload} />;
  const d = parsed.data;
  return (
    <div>
      <h4 style={{ margin: '0 0 0.2rem' }}>
        {d.category}
        {d.visibleCount !== d.totalCount ? (
          <span className="note">
            {' '}
            · showing {d.visibleCount} of {d.totalCount}
          </span>
        ) : null}
      </h4>
      <WeightsLine weights={d.weights} whatIf={d.whatIf} />
      <RankedTable rows={d.ranked} />
      <ExcludedList excluded={d.excluded} />
    </div>
  );
}

function WeightsLine({ weights, whatIf }: { weights: Record<string, number>; whatIf: boolean }) {
  return (
    <p className="note" style={{ margin: '0 0 0.6rem' }}>
      {whatIf ? 'What-if weights' : 'Program default weights'}:{' '}
      {WEIGHTED_CRITERIA.map((key) => `${CRITERION_LABELS[key]} ${weights[key] ?? 0}`).join(' · ')}
    </p>
  );
}

function RankedTable({ rows }: { rows: Row[] }) {
  if (rows.length === 0) return <p className="empty">Nothing is ranked here yet.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th className="num">Rank</th>
          <th>Supplier</th>
          <th className="num">Score</th>
          <th>Data confidence</th>
          <th>Flags</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.supplierId} className={r.visible === false ? 'hidden-by-filter' : undefined}>
            <td className="num">{r.rank}</td>
            <td>
              <strong>{r.displayName}</strong>
            </td>
            <td className="num">
              <strong>{fmtScore(r.score)}</strong>
              <div className="note">{coverageNote(r.coverage.computed, r.coverage.total)}</div>
            </td>
            <td>
              <span className={`badge ${confidenceTone(r.dataConfidence)}`}>
                {r.dataConfidence}
              </span>
            </td>
            <td>
              {r.disqualifying ? (
                <span className="badge bad" title={(r.disqualifyingFactors ?? []).join(', ')}>
                  disqualifying
                </span>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ExcludedList({ excluded }: { excluded: { row: Row; reason: string }[] }) {
  if (excluded.length === 0) return null;
  return (
    <div style={{ marginTop: '0.7rem' }}>
      <p className="note" style={{ margin: '0 0 0.3rem', fontWeight: 600 }}>
        In this program, but not rankable yet
      </p>
      <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
        {excluded.map((e) => (
          <li key={e.row.supplierId} className="note">
            <strong>{e.row.displayName}</strong>{' '}
            {e.reason === 'no_match'
              ? '— no settled match, no estimated criterion'
              : '— not mapped to this category'}
          </li>
        ))}
      </ul>
    </div>
  );
}

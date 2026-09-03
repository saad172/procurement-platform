import { z } from 'zod/v4';
import { EXCLUDED_HEADING, EXCLUDED_REASONS, SHORTLIST_EMPTY_LINE } from '@/domain/category-answer';
import { CRITERION_LABELS, WEIGHTED_CRITERIA, confidenceTone } from '@/domain/score';
import { RawPayload } from './raw';
import { coverageNote, fmtScore } from './criterion-format';

/**
 * `shortlist_table` — the Category page's `Shortlist` section in miniature
 * (`src/app/program/[programId]/category/[categoryId]/sections.tsx`), plus
 * the weight vector rendered as a row of six labelled weights: `get_shortlist`
 * carries its weights **as a rendered field** so the freeze is legible, not
 * merely true (SPEC §14.4) — a person reading the widget can see which
 * ranking produced it without a second lookup.
 *
 * **No link on a Supplier row.** `get_shortlist`'s widget payload names the
 * Category by string but carries no `programId` and no `categoryId` (finding
 * 103) — the page's URL needs both, and there is no safe way to recover
 * either from a Program-scoped chat without risking a citation-adjacent
 * figure pointing at the wrong Program's row.
 *
 * The page's two rules travel with it unchanged: a filtered row keeps its
 * true rank (`ExcludedList` below is the *other* half of that, never a
 * demoted rank), and Excluded is never a low Score — it is a different kind
 * of row entirely, split by reason.
 */

/** One other accepted Supplier this row's Network is joined to (network spec §7). Optional so an older frozen payload — recorded before this field existed — still parses (finding 103's own reasoning, applied here). */
const concentrationPartnerSchema = z.object({
  supplierId: z.string(),
  displayName: z.string(),
  terminalEntityId: z.string(),
  terminalLabel: z.string(),
});
const rowSchema = z.object({
  rank: z.number().nullable(),
  supplierId: z.string(),
  displayName: z.string(),
  score: z.number().nullable(),
  coverage: z.object({ computed: z.number(), total: z.number() }),
  dataConfidence: z.string(),
  disqualifying: z.boolean(),
  disqualifyingFactors: z.array(z.string()).optional(),
  concentrationWith: z.array(concentrationPartnerSchema).optional(),
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
  // Falls back rather than throws: a widget frozen onto a message outlives
  // the shape this schema names (finding 103).
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

/** ── The vector that produced this ranking ── */
function WeightsLine({ weights, whatIf }: { weights: Record<string, number>; whatIf: boolean }) {
  return (
    <p className="note" style={{ margin: '0 0 0.6rem' }}>
      {whatIf ? 'What-if weights' : 'Program default weights'}:{' '}
      {/*
        `get_shortlist` always resolves all six keys before freezing
        (`normaliseWeights`, `src/tools/catalog/reads.ts`), so `?? 0` is not a
        live gap — it is what stops an older frozen payload's missing key from
        rendering `undefined` instead of a number.
      */}
      {WEIGHTED_CRITERIA.map((key) => `${CRITERION_LABELS[key]} ${weights[key] ?? 0}`).join(' · ')}
    </p>
  );
}

/** ── Who is bidding, best fit first — the true rank, filtered rows kept in ── */
function RankedTable({ rows }: { rows: Row[] }) {
  if (rows.length === 0) return <p className="empty">{SHORTLIST_EMPTY_LINE}</p>;
  return (
    <table>
      <thead>
        <tr>
          <th className="num">Rank</th>
          <th>Supplier</th>
          <th className="num">Score</th>
          <th>Data confidence</th>
          <th>Flags</th>
          <th>Concentration</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          // `visible === false` rather than a filtered-out row missing: the
          // page's "gap is the disclosure" rule means a hidden row keeps its
          // seat and its true rank, just dimmed.
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
            <td>
              <ConcentrationBadge partners={r.concentrationWith ?? []} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Concentration, derived for free from stored Networks (network spec §7):
 * this row's Network shares a Path terminal with another accepted bidder's —
 * a shared parent, most often. Named partners and the shared entity ride in
 * the title, so a reader does not have to click through to learn *what*
 * joins them, only *that* something does. Mirrors the Category page's own
 * `ConcentrationBadge` (`sections.tsx`) — same wording, so the widget and the
 * page never say this two different ways.
 */
function ConcentrationBadge({
  partners,
}: {
  partners: { displayName: string; terminalLabel: string }[];
}) {
  if (partners.length === 0) return null;
  return (
    <span
      className="badge warn"
      title={partners.map((p) => `${p.displayName} — via ${p.terminalLabel}`).join('; ')}
    >
      joined with {partners.map((p) => p.displayName).join(', ')}
    </span>
  );
}

/**
 * ── In this program, but not rankable yet ──
 *
 * `no_match` and `no_category` are kept apart because they are different
 * problems for different people: the first has no Profile to measure and
 * belongs on Needs Review, the second is correctly resolved but bids on
 * nothing here and needs no action at all. The heading and each reason's
 * caption come from `domain/category-answer.ts`, the same constants the
 * page's `Excluded` section reads for its fuller paragraph — one wording per
 * reason, at two lengths.
 */
function ExcludedList({ excluded }: { excluded: { row: Row; reason: string }[] }) {
  if (excluded.length === 0) return null;
  return (
    <div style={{ marginTop: '0.7rem' }}>
      <p className="note" style={{ margin: '0 0 0.3rem', fontWeight: 600 }}>
        {EXCLUDED_HEADING}
      </p>
      <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
        {excluded.map((e) => (
          <li key={e.row.supplierId} className="note">
            <strong>{e.row.displayName}</strong> {excludedCaption(e.reason)}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** `reason` is a bare string off the frozen payload; only two values `EXCLUDED_REASONS` names ever reach here in practice. */
function excludedCaption(reason: string): string {
  const known = EXCLUDED_REASONS as Record<string, { caption: string } | undefined>;
  return known[reason]?.caption ?? `— excluded (${reason})`;
}

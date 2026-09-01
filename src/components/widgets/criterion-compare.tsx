import Link from 'next/link';
import { z } from 'zod/v4';
import { RawPayload } from './raw';
import { CRITERION_LABELS, WEIGHTED_CRITERIA, criterionBand } from './parts-table';

/**
 * `criterion_compare` — the one comparison no page draws: Suppliers ×
 * Criteria, banded the way `criterion-cell.tsx` bands every other Score.
 *
 * `compare_suppliers` accepts a `categoryId` but never filters on it, so a
 * Supplier bidding on two Categories can carry two current `tariff_exposure`
 * rows for one cell — both are rendered rather than one picked silently.
 * `supplier.findFirst` returning nothing serialises the whole `supplier` key
 * away, so that column reads "unmatched" with no id to link.
 */

const valueSchema = z.object({
  criterionKey: z.string(),
  value: z.number().nullable(),
  unknownReason: z.string().nullable(),
  rawInputs: z.record(z.string(), z.unknown()),
  anchorLine: z.string(),
});
const columnSchema = z.object({
  supplier: z
    .object({ id: z.string(), programId: z.string(), rosterName: z.string().nullable() })
    .optional(),
  values: z.array(valueSchema),
});
const payloadSchema = z.array(columnSchema).min(1);
type Column = z.infer<typeof columnSchema>;
type Value = z.infer<typeof valueSchema>;

export function CriterionCompareWidget({ payload }: { payload: unknown }) {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) return <RawPayload payload={payload} />;
  return <CompareTable columns={parsed.data} />;
}

function CompareTable({ columns }: { columns: Column[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Criterion</th>
          {columns.map((col, i) => (
            <ColumnHeader key={col.supplier?.id ?? i} supplier={col.supplier} />
          ))}
        </tr>
      </thead>
      <tbody>
        {WEIGHTED_CRITERIA.map((key) => (
          <tr key={key}>
            <td>{CRITERION_LABELS[key]}</td>
            {columns.map((col, i) => (
              <td key={col.supplier?.id ?? i}>
                <Cell entries={col.values.filter((v) => v.criterionKey === key)} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ColumnHeader({ supplier }: { supplier: Column['supplier'] }) {
  if (!supplier) {
    return (
      <th>
        <span className="note">unmatched</span>
      </th>
    );
  }
  return (
    <th>
      <Link href={`/program/${supplier.programId}/supplier/${supplier.id}` as never}>
        {supplier.rosterName ?? supplier.id}
      </Link>
    </th>
  );
}

function Cell({ entries }: { entries: Value[] }) {
  if (entries.length === 0) return <span className="note">—</span>;
  return (
    <>
      {entries.map((v, i) => (
        <ValueLine key={i} v={v} />
      ))}
    </>
  );
}

/** Never a bare number (SPEC §9.1) — value plus band plus the raw input beside it. */
function ValueLine({ v }: { v: Value }) {
  if (v.value == null) {
    return (
      <div>
        <span className="criterion-unknown">unknown</span>
        <div className="criterion-raw">{v.unknownReason ?? 'no reason recorded'}</div>
      </div>
    );
  }
  return (
    <div>
      <span className="criterion-value">{v.value.toFixed(1)}</span>{' '}
      <span className="badge mute">{criterionBand(v.value)}</span>
      <div className="criterion-raw">{describeRaw(v.rawInputs)}</div>
    </div>
  );
}

function describeRaw(raw: Record<string, unknown>): string {
  if (typeof raw.mfnRatePct === 'number') return `MFN ${raw.mfnRatePct}%`;
  if (typeof raw.km === 'number') return `${raw.km.toLocaleString('en-US')} km`;
  if (Array.isArray(raw.factorsScored)) {
    return raw.factorsScored.length === 0
      ? 'no risk factor deducted'
      : `${raw.factorsScored.length} risk factor(s) deducted`;
  }
  if (typeof raw.articleCount === 'number') return `${raw.articleCount} article(s)`;
  if (Array.isArray(raw.indicators)) return `${raw.indicators.length} of 6 indicators`;
  return '';
}

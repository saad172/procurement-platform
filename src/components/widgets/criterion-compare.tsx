import Link from 'next/link';
import { z } from 'zod/v4';
import { CRITERION_LABELS, WEIGHTED_CRITERIA } from '@/domain/score';
import { CriterionCell } from '@/components/criterion-cell';
import { RawPayload } from './raw';
import { toScoredCriterion } from './criterion-format';

/**
 * `criterion_compare` — the one comparison no page draws (SPEC §14.4):
 * Suppliers × Criteria, a grid rather than a ranking, drawn through the same
 * `CriterionCell` every page bands a Criterion with, so a band read off this
 * grid is the same claim as one read off the Supplier page. It exists
 * because a chat question — *"how does Bosch stack up against the other two
 * on compliance?"* — is a question the Shortlist and the Supplier page each
 * answer one row at a time, and this is the shape that answers it in one
 * table.
 *
 * `compare_suppliers` accepts a `categoryId` but never filters on it (finding
 * 103): a Supplier bidding on two Categories carries two current
 * `tariff_exposure` rows under one criterion key, so `Cell` renders every one
 * it is handed rather than pick a winner silently. `supplier.findFirst`
 * returning nothing serialises the whole `supplier` key away rather than
 * `null`, which is why a column's identity is checked with `supplier` (the
 * field), not a nullable id — the column is not "unmatched" (no Match ever
 * ran here), it is a row `compare_suppliers` could not resolve to a Supplier
 * at all.
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
  // Falls back rather than throws: a widget frozen onto a message outlives
  // the shape this schema names (finding 103).
  if (!parsed.success) return <RawPayload payload={payload} />;
  return <CompareTable columns={parsed.data} />;
}

/** ── Suppliers across the top, the six weighted Criteria down the side ── */
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

/** A column with no `supplier` is one `compare_suppliers` could not resolve — a payload gap, not a fourth Match outcome. */
function ColumnHeader({ supplier }: { supplier: Column['supplier'] }) {
  if (!supplier) {
    return (
      <th>
        <span className="note">supplier row not in this payload</span>
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

/** Usually one entry; more than one is the uncollapsed multi-Category case the header names. */
function Cell({ entries }: { entries: Value[] }) {
  if (entries.length === 0) return <span className="note">—</span>;
  return (
    <>
      {entries.map((v, i) => (
        <CriterionCell key={i} criterion={toScoredCriterion(v)} />
      ))}
    </>
  );
}

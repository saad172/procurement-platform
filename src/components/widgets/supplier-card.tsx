import Link from 'next/link';
import type { CriterionOutcome, ScoredCriterion } from '@/domain/score';
import { CriterionCell } from '@/components/criterion-cell';
import { RawPayload } from './raw';
import { arr, isObj, num, settledByLine, str } from './parts-card';

/**
 * `supplier_card` — mirrors the Supplier page's answer strip (SPEC §13.1):
 * roster name, who we believe it is and how that was settled, the Categories
 * it bids on, then its Criterion values with their bands.
 *
 * `getSupplier`'s widget payload is `loadSupplierCard`'s raw rows, not the
 * model's trimmed `data` projection (`src/tools/catalog/reads.ts`) — so this
 * has the full `match.entity` and the full `criterion_value` rows a person is
 * entitled to see.
 *
 * **Data confidence is left undrawn.** The band needs `presentEnrichments`
 * (`domain/score.ts` `dataConfidence()`), which this payload does not carry —
 * showing a badge computed without it would be a number the frozen row cannot
 * back.
 */
export function SupplierCardWidget({ payload }: { payload: unknown }) {
  const parsed = parse(payload);
  if (!parsed) return <RawPayload payload={payload} />;
  const { supplier, match, criterionValues } = parsed;
  const href =
    supplier.programId && supplier.id
      ? `/program/${supplier.programId}/supplier/${supplier.id}`
      : null;

  return (
    <div>
      <h4 style={{ margin: '0 0 0.3rem' }}>
        {href ? (
          <Link href={href as never}>{supplier.rosterName ?? '(promoted lead)'}</Link>
        ) : (
          (supplier.rosterName ?? '(promoted lead)')
        )}
      </h4>
      <MatchLine match={match} supplier={supplier} />
      <p className="note" style={{ margin: '0.4rem 0' }}>
        {supplier.categories.length > 0
          ? `Bids on ${supplier.categories.map((c) => c.name).join(', ')}`
          : 'Bids on no category here'}
      </p>
      <CriterionTable values={criterionValues} />
    </div>
  );
}

function MatchLine({ match, supplier }: { match: Parsed['match']; supplier: Parsed['supplier'] }) {
  if (!match) return <p className="note">nothing has been run against this row yet</p>;
  const entityHref =
    match.entityId && supplier.programId
      ? `/program/${supplier.programId}/entity/${match.entityId}`
      : null;
  if (match.settledBy === 'discovered') {
    return <p className="note">we found this one by searching, not from the roster</p>;
  }
  if (match.status !== 'accepted' || !match.entity) {
    return (
      <p className="note">
        <span className="term">
          nobody has confirmed which company this is<i>{match.status}</i>
        </span>
      </p>
    );
  }
  return (
    <p className="note">
      we believe this is{' '}
      <strong>
        {entityHref ? (
          <Link href={entityHref as never}>{match.entity.label}</Link>
        ) : (
          match.entity.label
        )}
      </strong>
      {match.entity.city ? `, ${match.entity.city}` : ''}{' '}
      <span className="term">
        {settledByLine(match.settledBy)}
        <i>settled by {match.settledBy}</i>
      </span>
    </p>
  );
}

function CriterionTable({ values }: { values: Parsed['criterionValues'] }) {
  if (values.length === 0) return <p className="note">no criterion has a value yet</p>;
  return (
    <table>
      <tbody>
        {values.map((v) => (
          <tr key={v.id}>
            <td style={{ whiteSpace: 'nowrap' }}>{v.criterionKey.replace(/_/g, ' ')}</td>
            <td>
              <CriterionCell criterion={toScoredCriterion(v)} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function toScoredCriterion(v: Parsed['criterionValues'][number]): ScoredCriterion {
  const outcome: CriterionOutcome =
    v.value == null
      ? {
          status: 'unknown',
          reason: v.unknownReason ?? 'unknown',
          rawInputs: v.rawInputs,
          anchorLine: v.anchorLine,
        }
      : {
          status: 'value',
          value: v.value,
          clamped: false,
          rawInputs: v.rawInputs,
          anchorLine: v.anchorLine,
        };
  return { key: v.criterionKey as never, outcome, effectiveWeight: 0, contribution: 0 };
}

type Parsed = NonNullable<ReturnType<typeof parse>>;

function parse(payload: unknown) {
  if (!isObj(payload) || !isObj(payload.supplier)) return null;
  const s = payload.supplier;
  const id = str(s.id);
  if (!id) return null;
  const categories = arr(s.categories)
    .map((c) => (isObj(c) && isObj(c.category) ? { name: str(c.category.name) ?? '?' } : null))
    .filter((c): c is { name: string } => c !== null);

  const m = isObj(payload.match) ? payload.match : null;
  const entity = m && isObj(m.entity) ? m.entity : null;
  const match = m
    ? {
        status: str(m.status) ?? 'needs review',
        settledBy: str(m.settledBy) ?? '?',
        entityId: str(m.entityId),
        entity:
          entity && str(entity.label)
            ? { label: str(entity.label)!, city: str(entity.city) }
            : null,
      }
    : null;

  const criterionValues = arr(payload.criterionValues)
    .map((v) =>
      isObj(v) && str(v.id) && str(v.criterionKey)
        ? {
            id: str(v.id)!,
            criterionKey: str(v.criterionKey)!,
            value: num(v.value),
            unknownReason: str(v.unknownReason),
            anchorLine: str(v.anchorLine) ?? '',
            rawInputs: isObj(v.rawInputs) ? v.rawInputs : {},
          }
        : null,
    )
    .filter((v): v is NonNullable<typeof v> => v !== null);

  return {
    supplier: {
      id,
      programId: str(s.programId),
      rosterName: str(s.rosterName),
      categories,
    },
    match,
    criterionValues,
  };
}

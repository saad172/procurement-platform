import Link from 'next/link';
import { PROMOTED_LEAD_LABEL, settledByLine } from '@/domain/supplier-answer';
import { CriterionCell } from '@/components/criterion-cell';
import { RawPayload } from './raw';
import { criterionLabel, toScoredCriterion } from './criterion-format';
import { arr, isObj, num, str } from './narrow';

/**
 * `supplier_card` — a chat-sized fusion of two Supplier-page sections that
 * stay apart on screen (`src/app/program/[programId]/supplier/[supplierId]/
 * sections.tsx`): `Heading`'s identity line (roster name, who we believe it
 * is, how that was settled) and `TheWorking`'s per-Criterion table, drawn
 * through the same `CriterionCell` the page uses (SPEC §13.1). A card has
 * room for one block, not five, so `Answer`, `WhoItIs` and `Enrichments` are
 * left for the page itself.
 *
 * `getSupplier`'s widget payload is `loadSupplierCard`'s **raw** rows, not
 * the model's trimmed `data` projection (`src/tools/catalog/reads.ts`
 * `projectSupplierCard`) — so this has the full `match.entity` and the full
 * `criterion_value` rows a person looking at their own chat is entitled to
 * see, where the model reading the same tool call is not.
 *
 * **Data confidence is left undrawn** (finding 103): its band needs
 * `presentEnrichments` (`domain/score.ts` `dataConfidence()`), which this
 * payload does not carry — a badge computed without it would be a number the
 * frozen row cannot back.
 */
export function SupplierCardWidget({ payload }: { payload: unknown }) {
  const parsed = parse(payload);
  // Falls back rather than throws: a widget frozen onto a message outlives
  // the shape `parse()` expects (finding 103).
  if (!parsed) return <RawPayload payload={payload} />;
  const { supplier, match, criterionValues } = parsed;
  // `supplier.programId` is a NOT NULL column on every current freeze; the
  // guard is for an older payload frozen before this widget existed to link.
  const href =
    supplier.programId && supplier.id
      ? `/program/${supplier.programId}/supplier/${supplier.id}`
      : null;

  return (
    <div>
      <h4 style={{ margin: '0 0 0.3rem' }}>
        {href ? (
          <Link href={href as never}>{supplier.rosterName ?? PROMOTED_LEAD_LABEL}</Link>
        ) : (
          (supplier.rosterName ?? PROMOTED_LEAD_LABEL)
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

/** ── Who we believe this is, and how that was settled — `Heading`'s line, one card down ── */
function MatchLine({ match, supplier }: { match: Parsed['match']; supplier: Parsed['supplier'] }) {
  if (!match) return <p className="note">nothing has been run against this row yet</p>;
  const entityHref =
    match.entityId && supplier.programId
      ? `/program/${supplier.programId}/entity/${match.entityId}`
      : null;
  // A promoted Lead reads "found by searching", never "verified" — no name
  // matching happened for it to be strong or weak at (Heading carries the
  // same rule; see its own comment for why the words differ from a resolved
  // Match's).
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

/** ── The Criterion table, through the page's own `CriterionCell` so a band can never drift ── */
function CriterionTable({ values }: { values: Parsed['criterionValues'] }) {
  if (values.length === 0) return <p className="note">no criterion has a value yet</p>;
  return (
    <table>
      <tbody>
        {values.map((v) => (
          <tr key={v.id}>
            <td style={{ whiteSpace: 'nowrap' }}>{criterionLabel(v.criterionKey)}</td>
            <td>
              <CriterionCell criterion={toScoredCriterion(v)} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

type Parsed = NonNullable<ReturnType<typeof parse>>;

/** Every field optional-checked by hand: this payload is `loadSupplierCard`'s raw shape, not a declared schema. */
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

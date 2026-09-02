import { RawPayload } from './raw';
import { bool, isoDate, isObj, num, str } from './narrow';

/**
 * `entity_card` — the Entity page's `Heading` and `Attributes` sections
 * (`src/app/program/[programId]/entity/[entityId]/sections.tsx`), the bottom
 * of the spine `Program → Category → Supplier → Sayari entity → record`
 * (SPEC §13.1, §13.7).
 *
 * `get_entity`'s payload is the raw `entity` row (SPEC §3.2): a Sayari entity
 * projected onto the local table, whether or not any Supplier's Match points
 * at it — the page's `KnownAsClause` (Profile, Family member or Candidate)
 * is not drawn here, because that reads three joins `get_entity` never runs
 * (finding 103's shape, one row down from the tools it names). **No link**:
 * the row carries no `programId`, and the entity page's URL needs one —
 * guessing it would point at the wrong Program's copy of the same company.
 */
export function EntityCardWidget({ payload }: { payload: unknown }) {
  const e = parse(payload);
  // Falls back rather than throws: a widget frozen onto a message outlives
  // the shape `parse()` expects (finding 103).
  if (!e) return <RawPayload payload={payload} />;
  return (
    <div>
      <h4 style={{ margin: '0 0 0.2rem' }}>{e.label}</h4>
      <p className="sub" style={{ margin: '0 0 0.5rem' }}>
        <span className="mono">{e.id}</span>
        {e.country ? ` · ${e.country}` : ''}
        {e.lei ? ` · LEI ${e.lei}` : ' · no LEI'}
      </p>
      <AttributeTable e={e} />
    </div>
  );
}

/** ── `Attributes`, in the page's own row order ── */
function AttributeTable({ e }: { e: Parsed }) {
  return (
    <table>
      <tbody>
        <Row label="Type" value={e.entityType ?? '—'} />
        <Row label="Address" value={e.addressLine ?? '—'} />
        <Row label="City" value={e.city ?? '—'} />
        <Row
          label="Coordinates"
          value={
            e.lat != null && e.lon != null
              ? `${e.lat.toFixed(4)}, ${e.lon.toFixed(4)}`
              : 'none recorded'
          }
        />
        <Row label="Distinct sources" value={e.distinctSourceCount ?? '—'} />
        {/* `psaCount`: possibly_same_as — other Sayari records of this same company, i.e. its Twins. A Twin is evidence, never identity (CONTEXT.md). */}
        <Row label="Other records of this company" value={e.psaCount ?? 0} />
        <Row
          label="First seen / last fetched"
          value={`${isoDate(e.firstSeenAt)} · ${isoDate(e.fetchedAt)}`}
        />
        <tr>
          <td>Sanctioned / PEP / closed</td>
          <td>
            {/* Each flag is Sayari's own, never derived here — three independent badges, not one traffic light. */}
            {e.sanctioned ? <span className="badge bad">sanctioned</span> : null}{' '}
            {e.pep ? <span className="badge warn">PEP</span> : null}{' '}
            {e.closed ? <span className="badge warn">closed</span> : null}
            {!e.sanctioned && !e.pep && !e.closed ? <span className="note">none</span> : null}
          </td>
        </tr>
      </tbody>
    </table>
  );
}

function Row({ label, value }: { label: string; value: string | number }) {
  return (
    <tr>
      <td>{label}</td>
      <td>{value}</td>
    </tr>
  );
}

type Parsed = NonNullable<ReturnType<typeof parse>>;

/** Every field optional-checked by hand: this payload is the raw `entity` row, not a declared schema. */
function parse(payload: unknown) {
  if (!isObj(payload)) return null;
  const id = str(payload.id);
  const label = str(payload.label);
  if (!id || !label) return null;
  return {
    id,
    label,
    entityType: str(payload.entityType),
    country: str(payload.country),
    addressLine: str(payload.addressLine),
    city: str(payload.city),
    lat: num(payload.lat),
    lon: num(payload.lon),
    lei: str(payload.lei),
    distinctSourceCount: num(payload.distinctSourceCount),
    psaCount: num(payload.psaCount),
    sanctioned: bool(payload.sanctioned),
    pep: bool(payload.pep),
    closed: bool(payload.closed),
    firstSeenAt: payload.firstSeenAt,
    fetchedAt: payload.fetchedAt,
  };
}

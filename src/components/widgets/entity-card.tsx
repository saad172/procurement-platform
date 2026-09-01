import { RawPayload } from './raw';
import { bool, isoDate, isObj, num, str } from './parts-card';

/**
 * `entity_card` — mirrors the Entity page's `Heading` and `Attributes`
 * (`src/app/program/[programId]/entity/[entityId]/sections.tsx`).
 *
 * `get_entity`'s payload is the raw `entity` row (SPEC §3.2): a Sayari entity
 * projected onto the local table, whether or not any Supplier's Match points
 * at it. **No link**: the row carries no `programId`, and the entity page's
 * URL needs one — guessing it would point at the wrong program's copy of the
 * same company.
 */
export function EntityCardWidget({ payload }: { payload: unknown }) {
  const e = parse(payload);
  if (!e) return <RawPayload payload={payload} />;
  return (
    <div>
      <h4 style={{ margin: '0 0 0.2rem' }}>{e.label}</h4>
      <p className="sub" style={{ margin: '0 0 0.5rem' }}>
        <span className="mono">{e.id}</span>
        {e.country ? ` · ${e.country}` : ''}
        {e.lei ? ` · LEI ${e.lei}` : ' · no LEI'}
      </p>
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
          <Row label="Other records of this company" value={e.psaCount ?? 0} />
          <Row
            label="First seen / last fetched"
            value={`${isoDate(e.firstSeenAt)} · ${isoDate(e.fetchedAt)}`}
          />
          <tr>
            <td>Sanctioned / PEP / closed</td>
            <td>
              {e.sanctioned ? <span className="badge bad">sanctioned</span> : null}{' '}
              {e.pep ? <span className="badge warn">PEP</span> : null}{' '}
              {e.closed ? <span className="badge warn">closed</span> : null}
              {!e.sanctioned && !e.pep && !e.closed ? <span className="note">none</span> : null}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
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

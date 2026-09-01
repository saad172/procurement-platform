import { RawPayload } from './raw';
import { arr, bool, isObj, num, str } from './parts-card';

/**
 * `supplier_family` — mirrors `CorporateFamily`'s *not covered* vs *n explored*
 * framing (`src/app/program/[programId]/supplier/[supplierId]/sections.tsx`,
 * CONTEXT.md's *Corporate family*). **No link**: this payload carries no
 * `programId` and no `supplierId` for the entity or supplier pages to hang off.
 *
 * The page's own exposure badge excludes country-derived factors by a
 * `metadata.country` marker (`domain/scoring/risk-factors.ts`
 * `isCountryDerived`), and `get_supplier_family`'s projection drops that marker
 * before freezing. Rather than claim the page's exact *exposure found / no
 * exposure found* verdict on data that cannot reproduce it, this filters the
 * three named country-derived factors by name (`cpi_score`, `basel_aml`,
 * `eu_high_risk_third`, per `db/schema/entities.ts`) as a labelled
 * approximation, and shows every other factor a member carries.
 */
const COUNTRY_DERIVED_NAMES = new Set(['cpi_score', 'basel_aml', 'eu_high_risk_third']);

export function SupplierFamilyWidget({ payload }: { payload: unknown }) {
  const f = parse(payload);
  if (!f) return <RawPayload payload={payload} />;
  if (f.members.length === 0) {
    return (
      <div>
        <span className="badge mute">not covered</span>
        <p className="note" style={{ margin: '0.4rem 0 0' }}>
          The ownership graph returned nobody. That is not the same as a clean family.
        </p>
      </div>
    );
  }
  return (
    <div>
      <span className="badge">
        {f.explored} explored{f.truncated ? ' · capped, more may exist' : ''}
      </span>
      <table style={{ marginTop: '0.5rem' }}>
        <tbody>
          {f.members.map((m) => (
            <MemberRow key={m.entityId} member={m} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MemberRow({ member }: { member: Parsed['members'][number] }) {
  const own = member.riskFactors.filter((r) => !COUNTRY_DERIVED_NAMES.has(r.name) && r.level);
  return (
    <tr>
      <td>
        {member.label}
        {member.sanctioned ? (
          <span className="badge bad" style={{ marginLeft: '0.3rem' }}>
            sanctioned
          </span>
        ) : null}
      </td>
      <td className="note">{member.country ?? '—'}</td>
      <td className="note">hop {member.hopDepth}</td>
      <td>
        {own.length === 0 ? (
          <span className="note">no risk factor found</span>
        ) : (
          own.slice(0, 3).map((r) => (
            <span
              key={r.name}
              className={`badge ${r.level === 'high' ? 'bad' : 'warn'}`}
              style={{ marginRight: '0.2rem' }}
            >
              {r.level}
            </span>
          ))
        )}
      </td>
    </tr>
  );
}

type Parsed = NonNullable<ReturnType<typeof parse>>;

function parse(payload: unknown) {
  if (!isObj(payload) || !str(payload.entityId)) return null;
  const members = arr(payload.members)
    .map((m) => {
      if (!isObj(m) || !str(m.entityId) || !str(m.label)) return null;
      return {
        entityId: str(m.entityId)!,
        label: str(m.label)!,
        country: str(m.country),
        hopDepth: num(m.hopDepth) ?? 0,
        sanctioned: bool(m.sanctioned),
        riskFactors: arr(m.riskFactors)
          .map((r) =>
            isObj(r) && str(r.name) ? { name: str(r.name)!, level: str(r.level) } : null,
          )
          .filter((r): r is { name: string; level: string | null } => r !== null),
      };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null);

  return {
    entityId: str(payload.entityId)!,
    explored: num(payload.explored) ?? members.length,
    truncated: bool(payload.truncated),
    members,
  };
}

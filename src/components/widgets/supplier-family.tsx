import { isCountryDerived } from '@/domain/scoring/risk-factors';
import { RawPayload } from './raw';
import { arr, bool, isObj, num, str } from './narrow';

/**
 * `supplier_family` — the Supplier page's `CorporateFamily` section
 * (`src/app/program/[programId]/supplier/[supplierId]/sections.tsx`), the
 * *not covered* vs *n explored* framing CONTEXT.md's **Corporate family**
 * entry defines (SPEC §8). **No link**: this payload carries no `programId`
 * and no `supplierId` for the entity or supplier pages to hang off — only the
 * root `entityId`, which names the Profile but cannot address the page it
 * came from.
 *
 * `get_supplier_family`'s projection (`src/tools/catalog/reads.ts`) now
 * carries each factor's `country` marker alongside its name and level, so
 * this widget excludes country-derived factors the same way the page and
 * `score.ts` do — through `isCountryDerived()`, one predicate, rather than
 * re-testing the three factor names it used to hold as its own copy.
 */
export function SupplierFamilyWidget({ payload }: { payload: unknown }) {
  const f = parse(payload);
  // Falls back rather than throws: a widget frozen onto a message outlives
  // the shape `parse()` expects (finding 103).
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
        {/*
          Never invented from `members.length`: that count is rows PRESENT,
          not rows the traversal reported covering, and the two differ
          whenever a Profile was enriched twice (`get_supplier_family`'s own
          comment). A payload frozen before `explored` existed says so rather
          than silently answering a different question.
        */}
        {f.explored != null ? `${f.explored} explored` : 'explored count not frozen'}
        {f.truncated ? ' · capped, more may exist' : ''}
      </span>
      <p className="note" style={{ margin: '0.4rem 0' }}>
        Country-derived factors — CPI, Basel AML, EU high-risk-third — are excluded here, the same
        exclusion Compliance risk applies on the page (finding 103).
      </p>
      <table style={{ marginTop: '0.3rem' }}>
        <tbody>
          {f.members.map((m) => (
            <MemberRow key={m.entityId} member={m} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One member: label, sanctioned badge, country, hop depth, and up to three of its own (non-country-derived) risk factors. */
function MemberRow({ member }: { member: Parsed['members'][number] }) {
  const own = member.riskFactors.filter(
    (r) =>
      !isCountryDerived({
        name: r.name,
        level: undefined,
        country: r.country,
        traversalPath: null,
        value: null,
      }) && r.level,
  );
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
            isObj(r) && str(r.name)
              ? {
                  name: str(r.name)!,
                  level: str(r.level),
                  country: 'country' in r ? r.country : null,
                }
              : null,
          )
          .filter((r): r is { name: string; level: string | null; country: unknown } => r !== null),
      };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null);

  return {
    entityId: str(payload.entityId)!,
    explored: num(payload.explored),
    truncated: bool(payload.truncated),
    members,
  };
}

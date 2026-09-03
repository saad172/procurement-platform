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
 * **Grouped by kind, per `get_supplier_network`'s payload** (network spec
 * §9): `{ entityId, groups: { family, watchlist, shortest_path,
 * deep_traversal, supply_chain } }`, each group carrying the shape a single
 * family envelope used to carry alone — `enrichmentId`, `explored`,
 * `reachable`, `truncated`, `members`. A group with no Paths is a real,
 * reported state (*not covered*), never hidden — `shortest_path`,
 * `deep_traversal` and `supply_chain` groups are empty for most Profiles
 * today (tickets 04/05 are what write them), and showing that plainly is
 * the point: an empty group here is a different fact from a family group
 * that came back with real coverage and no exposure.
 *
 * `get_supplier_network`'s projection (`src/tools/catalog/reads.ts`) carries
 * each factor's `country` marker alongside its name and level, so this
 * widget excludes country-derived factors the same way the page and
 * `score.ts` do — through `isCountryDerived()`, one predicate, rather than
 * re-testing the three factor names it used to hold as its own copy.
 *
 * Each member also carries `recordId` — the record asserting THIS member's
 * own edge (network spec §6, ticket 02 "Done when"), never the read that
 * found it. Rendered as text, not a `Link`: this payload carries no
 * `programId` (this file's own note, above) for a `/record/[...recordId]`
 * href to hang off, the same limitation that already keeps `entityId`
 * text-only here.
 */
export function SupplierFamilyWidget({ payload }: { payload: unknown }) {
  const f = parse(payload);
  // Falls back rather than throws: a widget frozen onto a message outlives
  // the shape `parse()` expects (finding 103) — including a message frozen
  // before this ticket, whose payload is the OLD flat `{ entityId, explored,
  // truncated, members }` shape with no `groups` at all. `parse()` refuses
  // that shape below rather than silently reading nothing out of it.
  if (!f) return <RawPayload payload={payload} />;
  return (
    <div>
      {NETWORK_KIND_ORDER.map((kind) => (
        <NetworkGroupSection key={kind} kind={kind} group={f.groups[kind]} />
      ))}
    </div>
  );
}

const NETWORK_KIND_ORDER = [
  'family',
  'watchlist',
  'shortest_path',
  'deep_traversal',
  'supply_chain',
] as const;

type NetworkKind = (typeof NETWORK_KIND_ORDER)[number];

/** A buyer-facing label per `graph_path.kind` (network spec §6), not the enum spelling. */
const KIND_LABEL: Record<NetworkKind, string> = {
  family: 'Corporate family (ownership)',
  watchlist: 'Watchlist',
  shortest_path: 'Shortest path',
  deep_traversal: 'Deep traversal',
  supply_chain: 'Supply chain',
};

/** What "not covered" says for each kind — the same "not the same as a clean read" framing the family group always used, worded per kind. */
const KIND_NOT_COVERED_NOTE: Record<NetworkKind, string> = {
  family: 'The ownership graph returned nobody. That is not the same as a clean family.',
  watchlist: 'No Path to a Listed entity was found. That is not the same as a clean watchlist read.',
  shortest_path: 'No shortest-path Concentration check has been run for this Supplier yet.',
  deep_traversal: 'No Deep Traversal has been run for this Supplier yet.',
  supply_chain: 'No supply-chain Path has been found for this Supplier yet.',
};

function NetworkGroupSection({ kind, group }: { kind: NetworkKind; group: ParsedGroup }) {
  return (
    <div style={{ marginTop: '0.6rem' }}>
      <h4 style={{ margin: '0 0 0.2rem' }}>{KIND_LABEL[kind]}</h4>
      {group.members.length === 0 ? (
        <div>
          <span className="badge mute">not covered</span>
          <p className="note" style={{ margin: '0.2rem 0 0' }}>{KIND_NOT_COVERED_NOTE[kind]}</p>
        </div>
      ) : (
        <div>
          <span className="badge">
            {/*
              Never invented from `members.length`: that count is rows
              PRESENT, not rows the traversal reported covering, and the two
              differ whenever a Profile was enriched twice (this group's own
              `explored`, from `get_supplier_network`).
            */}
            {group.explored != null ? `${group.explored} explored` : 'explored count not frozen'}
            {group.truncated ? ' · capped, more may exist' : ''}
          </span>
          {kind === 'family' ? (
            <p className="note" style={{ margin: '0.4rem 0' }}>
              Country-derived factors — CPI, Basel AML, EU high-risk-third — are excluded here, the
              same exclusion Compliance risk applies on the page (finding 103).
            </p>
          ) : null}
          <table style={{ marginTop: '0.3rem' }}>
            <tbody>
              {group.members.map((m) => (
                <MemberRow key={m.entityId} member={m} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** One member: label, sanctioned badge, country, hop depth, and up to three of its own (non-country-derived) risk factors. */
function MemberRow({ member }: { member: ParsedMember }) {
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
      <td className="note mono">{member.recordId ?? 'no record cited yet'}</td>
    </tr>
  );
}

type ParsedMember = {
  entityId: string;
  label: string;
  country: string | null;
  hopDepth: number;
  sanctioned: boolean;
  recordId: string | null;
  riskFactors: { name: string; level: string | null; country: unknown }[];
};

type ParsedGroup = {
  enrichmentId: string | null;
  explored: number | null;
  reachable: number | null;
  truncated: boolean;
  members: ParsedMember[];
};

type Parsed = { entityId: string; groups: Record<NetworkKind, ParsedGroup> };

function parseMember(m: unknown): ParsedMember | null {
  if (!isObj(m) || !str(m.entityId) || !str(m.label)) return null;
  return {
    entityId: str(m.entityId)!,
    label: str(m.label)!,
    country: str(m.country),
    hopDepth: num(m.hopDepth) ?? 0,
    sanctioned: bool(m.sanctioned),
    // Absent on a payload frozen before this field existed — `str()`
    // returns null either way, which reads as "no record cited yet" rather
    // than throwing `parse()` back to `RawPayload`.
    recordId: str(m.recordId),
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
}

/** An absent or malformed kind reads as a genuinely empty group, never a parse failure — a kind this build has not written any Paths of yet (`shortest_path`, `deep_traversal`, `supply_chain`) is exactly that shape. */
function parseGroup(raw: unknown): ParsedGroup {
  if (!isObj(raw)) return { enrichmentId: null, explored: null, reachable: null, truncated: false, members: [] };
  return {
    enrichmentId: str(raw.enrichmentId),
    explored: num(raw.explored),
    reachable: num(raw.reachable),
    truncated: bool(raw.truncated),
    members: arr(raw.members)
      .map(parseMember)
      .filter((m): m is ParsedMember => m !== null),
  };
}

/**
 * Requires `groups` to be present and an object — the one thing the OLD flat
 * shape (`{ entityId, explored, truncated, members }`, frozen before this
 * ticket) never had. Without this check `arr(payload.members)` on the new
 * shape silently reads `[]` and every group renders "not covered" for a
 * Supplier that may carry real Paths — a wrong answer shown as if it were
 * real, not a parse failure a person could see past. Refusing to `parse()` a
 * payload with no `groups` at all sends it to `RawPayload` instead, which is
 * the fallback finding 103 describes for exactly this situation.
 */
function parse(payload: unknown): Parsed | null {
  if (!isObj(payload) || !str(payload.entityId) || !isObj(payload.groups)) return null;
  const rawGroups = payload.groups;
  const groups = Object.fromEntries(
    NETWORK_KIND_ORDER.map((kind) => [kind, parseGroup(rawGroups[kind])]),
  ) as Record<NetworkKind, ParsedGroup>;
  return { entityId: str(payload.entityId)!, groups };
}

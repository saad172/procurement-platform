import Link from 'next/link';
import { Breadcrumb } from '@/components/breadcrumb';
import { NetworkMapWithExpand } from '@/components/widgets/expand-node-button';
import type { loadEntityPage } from '@/db/queries/entity-page';
import type { KnownAsCase } from '@/domain/derive-entity-page';
import {
  effectiveLevel,
  isCountryDerived,
  isTwinFactor,
  variantOf,
} from '@/domain/scoring/risk-factors';
import { PROMOTED_LEAD_LABEL } from '@/domain/supplier-answer';
import { fetchOwnRecord } from './entity-actions';

/**
 * The Sayari entity page's sections (SPEC §13.1, §13.7) — one component per
 * `<h2>`, plus `Heading`, `Attributes` and `RelationshipCounts` for the
 * chrome ahead of the first one.
 */
type Data = NonNullable<Awaited<ReturnType<typeof loadEntityPage>>>;

/**
 * **Reached from the Assessment, not only from a menu**: clicking a Citation's
 * `❡` navigates here, because a Citation is a hop rather than a tooltip. A
 * tooltip would make the evidence something you glance at; a page makes it
 * somewhere you can stand.
 */
export function Heading({ data, programId }: { data: Data; programId: string }) {
  const { entity, program, knownAs, breadcrumbSupplier } = data;
  // Not the Category: a Supplier bids on one or more of them, so there is no
  // single parent to name here — the same reason the Supplier page's own
  // breadcrumb stops at the Program (SPEC §13.1). `breadcrumbSupplier` is
  // `deriveKnownAs()`'s call on "exactly one Profile case" — this component
  // only reads it, so the rule stays unit-tested apart from Postgres.
  const trail = breadcrumbSupplier
    ? [
        { label: program?.name ?? 'Program', href: `/program/${programId}` },
        {
          label: breadcrumbSupplier.rosterName ?? PROMOTED_LEAD_LABEL,
          href: `/program/${programId}/supplier/${breadcrumbSupplier.id}`,
        },
        { label: entity.label },
      ]
    : [
        { label: program?.name ?? 'Program', href: `/program/${programId}` },
        { label: entity.label },
      ];
  return (
    <>
      <Breadcrumb trail={trail} />
      <h1>{entity.label}</h1>
      <p className="sub">
        <span className="mono">{entity.id}</span>
        {entity.country ? ` · ${entity.country}` : ''}
        {entity.lei ? ` · LEI ${entity.lei}` : ' · no LEI'}
      </p>
      <p className="sub">
        {knownAs.length === 0
          ? 'known to no Supplier in this Program'
          : knownAs.map((item, i) => (
              <span key={`${item.kind}-${item.supplier.id}`}>
                {i > 0 ? ' · ' : ''}
                <KnownAsClause item={item} programId={programId} />
              </span>
            ))}
      </p>
    </>
  );
}

/**
 * One clause of the "known as" line: the buyer's sentence on the surface, the
 * canonical term underneath it the way the Supplier page's own Heading writes
 * `settled by {match.settledBy}` (see `.term` in `globals.css`).
 */
function KnownAsClause({ item, programId }: { item: KnownAsCase; programId: string }) {
  const name = item.supplier.rosterName ?? PROMOTED_LEAD_LABEL;
  const parked = item.kind === 'candidate' && item.parked;
  // A parked Candidate has no settled home yet, so its link is the queue a
  // person works from rather than a Supplier page whose "who it is" answer
  // does not exist.
  const href = parked
    ? `/program/${programId}/needs-review/${item.supplier.id}`
    : `/program/${programId}/supplier/${item.supplier.id}`;
  const supplierLink = (
    <Link href={href as never}>
      <strong>{name}</strong>
    </Link>
  );

  // Each surface sentence below says the relationship in words that are not
  // just the canonical term again — `<i>Profile</i>` / `<i>Family member ·
  // hop N</i>` / `<i>Candidate</i>` carry the glossary noun, capitalised as
  // CONTEXT.md defines it, so a reader who wants the exact word for what
  // they are looking at finds it underneath rather than reading it twice.
  if (item.kind === 'profile') {
    return (
      <span className="term">
        the company {supplierLink} resolved to
        {item.supplier.rosterIndex != null ? `, roster row ${item.supplier.rosterIndex}` : ''}
        <i>Profile</i>
      </span>
    );
  }
  if (item.kind === 'family') {
    const hops = item.hopDepth === 1 ? 'hop' : 'hops';
    return (
      <span className="term">
        one of the group companies under {supplierLink}, {item.hopDepth} {hops} down
        <i>Family member · hop {item.hopDepth}</i>
      </span>
    );
  }
  return (
    <span className="term">
      one of the companies considered for {supplierLink}
      {parked ? ' — still waiting on a person' : ''}
      <i>Candidate</i>
    </span>
  );
}

export function Attributes({ data }: { data: Data }) {
  const { entity } = data;
  return (
    <section className="card">
      <h3 style={{ marginTop: 0 }}>Attributes</h3>
      <table>
        <tbody>
          <tr>
            <td>Type</td>
            <td>{entity.entityType ?? '—'}</td>
          </tr>
          <tr>
            <td>Address</td>
            <td>{entity.addressLine ?? '—'}</td>
          </tr>
          <tr>
            <td>City</td>
            <td>{entity.city ?? '—'}</td>
          </tr>
          <tr>
            <td>Postcode</td>
            <td className="mono">{entity.postcode ?? '—'}</td>
          </tr>
          <tr>
            <td>Coordinates</td>
            <td>
              {/*
                Sayari's own coordinates supersede external geocoding for a
                resolved Profile, so the Proximity criterion is measured
                from these — worth showing beside the number they produce.
              */}
              {entity.lat != null && entity.lon != null ? (
                <span className="mono">
                  {entity.lat.toFixed(4)}, {entity.lon.toFixed(4)}
                </span>
              ) : (
                <span className="note">none recorded — proximity falls back to geocoding</span>
              )}
            </td>
          </tr>
          <tr>
            <td>Distinct sources</td>
            <td>
              {entity.distinctSourceCount ?? '—'}
              {/*
                `sourceCount` is an OBJECT keyed by source hash, not a
                scalar, so the band must say which it means — and it means
                distinct sources.
              */}
              <span className="note"> distinct sources, not a summed count</span>
            </td>
          </tr>
          <tr>
            <td>Other records of this company</td>
            <td>
              {entity.psaCount ?? 0}
              {(entity.psaCount ?? 0) > 0 ? (
                <span className="note">
                  {' '}
                  — a twin is the same company for evidence and never for identity
                </span>
              ) : null}
            </td>
          </tr>
          <tr>
            <td>First seen / last fetched</td>
            <td className="note">
              {/*
                `firstSeenAt` is never re-stamped: the *new evidence*
                staleness mark is computed from it, so a row first seen
                after a version was written is what makes that version
                stale.
              */}
              {entity.firstSeenAt.toISOString().slice(0, 10)} ·{' '}
              {entity.fetchedAt.toISOString().slice(0, 10)}
            </td>
          </tr>
          <tr>
            <td>Sanctioned / PEP / closed</td>
            <td>
              {entity.sanctioned ? <span className="badge bad">sanctioned</span> : null}
              {entity.pep ? <span className="badge warn">PEP</span> : null}
              {entity.closed ? <span className="badge warn">closed</span> : null}
              {!entity.sanctioned && !entity.pep && !entity.closed ? (
                <span className="note">none</span>
              ) : null}
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}

export function RelationshipCounts({ data }: { data: Data }) {
  const { entity, edges } = data;
  return (
    <section className="card">
      <h3 style={{ marginTop: 0 }}>Relationship counts</h3>
      {/*
        `relationshipCount` is an OBJECT keyed by relation type, and that is
        what distinguishes "this company has no recorded owner" from "we did
        not look far enough" — at zero cost.
      */}
      <table>
        <tbody>
          {Object.entries((entity.relationshipCount ?? {}) as Record<string, number>)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 8)
            .map(([type, count]) => (
              <tr key={type}>
                <td>{type.replace(/_/g, ' ')}</td>
                <td className="num">{count.toLocaleString('en-US')}</td>
              </tr>
            ))}
        </tbody>
      </table>
      {entity.relationshipsTruncated ? (
        <p className="note">
          The returned window was smaller than these counts, so the graph read here is incomplete by
          construction — which is a different thing from an absent relationship.
        </p>
      ) : null}
      <p className="note">{edges.length} edge(s) stored locally.</p>
    </section>
  );
}

/** ── Sources ── */
export function Sources({ data }: { data: Data }) {
  const { sources } = data;
  return (
    <>
      {/*
        `sourceCount` is an object keyed by source hash, and each value carries
        the source's own label, country and kind. The page counted the keys and
        showed the total — the names of the sources a company is known from were
        stored on every row and displayed nowhere.
      */}
      <h2>
        Sources{' '}
        <span className="note">
          {sources.length} distinct,{' '}
          {sources.reduce((sum, s) => sum + s.count, 0).toLocaleString('en-US')} mentions in total
        </span>
      </h2>
      {sources.length === 0 ? (
        <div className="card">
          <p className="note" style={{ margin: 0 }}>
            No source breakdown stored for this company.
          </p>
        </div>
      ) : (
        <div className="card scroll-x">
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>Kind</th>
                <th>Country</th>
                <th className="num">Mentions</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((source) => (
                <tr key={source.hash}>
                  <td>{source.label}</td>
                  <td className="note">{source.sourceType.replace(/_/g, ' ')}</td>
                  <td className="mono note">{source.country}</td>
                  <td className="num">{source.count.toLocaleString('en-US')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/** ── Risk factors, and how each was treated ── */
export function RiskFactors({ data }: { data: Data }) {
  const { factors } = data;
  return (
    <>
      <h2>Risk factors, and how each was treated</h2>
      <div className="card scroll-x">
        {factors.length === 0 ? (
          <p className="empty">
            This record carries no risk factors. An empty risk object is never clean on its own — it
            is only clean when coverage is adequate.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Factor</th>
                <th>Reported</th>
                <th>Scored at</th>
                <th>Why</th>
                <th>Source(s)</th>
                <th>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {factors.map((factor) => (
                <RiskFactorRow key={factor.name} factor={factor} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function RiskFactorRow({ factor }: { factor: Data['factors'][number] }) {
  const scored = effectiveLevel(factor);
  const variant = variantOf(factor.name);
  const twin = isTwinFactor(factor.name);
  const country = isCountryDerived(factor);
  return (
    <tr>
      <td className="mono">{factor.name}</td>
      <td>
        <span className="badge">{factor.level ?? '—'}</span>
      </td>
      <td>
        {country ? (
          <span className="note">excluded</span>
        ) : scored ? (
          <span className="badge warn">{scored}</span>
        ) : (
          <span className="note">badge only</span>
        )}
      </td>
      <td className="note">
        {country
          ? 'country-derived — scoring it here would double-count country resilience'
          : variant === 'subtier'
            ? '`_subtier` badges and never deducts'
            : variant === 'indirect' || variant === 'adjacent'
              ? `\`_${variant}\` scores one band down`
              : twin
                ? 'a twin’s factor: deducts, but never raises the disqualifying badge'
                : 'scored at full weight'}
      </td>
      {/*
        Which endpoint(s) reported this factor (SPEC §8.2 D5, item A) — joined
        back in from the `risk_sources` sibling column. A factor upserted
        before this ticket, or a row `attachRiskSources` had nothing to add
        to, reads "—" rather than a false claim.
      */}
      <td className="note">{factor.sources?.length ? factor.sources.join(', ') : '—'}</td>
      {/*
        The structured evidence `attachRiskIntelligence` (`@/domain/scoring/
        risk-factors`) joins in from `attributes.risk_intelligence` — a
        program, an authority, a list and an effective-date range, when
        Sayari attaches them. Most factors have none, which reads "—" rather
        than a false claim, same as Source(s) above.
      */}
      <td className="note">
        {factor.riskIntelligence?.length ? (
          <>
            {factor.riskIntelligence.map((entry, i) => (
              <div key={i}>{riskIntelligenceLine(entry)}</div>
            ))}
          </>
        ) : (
          '—'
        )}
      </td>
    </tr>
  );
}

/** One `RiskIntelligenceEntry` as one line of readable evidence. */
function riskIntelligenceLine(
  entry: NonNullable<Data['factors'][number]['riskIntelligence']>[number],
): string {
  const parts = [
    entry.list ?? entry.program,
    entry.authority ? `via ${entry.authority}` : undefined,
    entry.fromDate
      ? `from ${entry.fromDate}${entry.toDate ? ` to ${entry.toDate}` : ''}`
      : undefined,
  ].filter((p): p is string => Boolean(p));
  if (parts.length === 0 && entry.reason) return entry.reason;
  return parts.length > 0 ? parts.join(', ') : '—';
}

/**
 * ── Paths through this entity ──
 *
 * Network spec §8's own Display table, Entity row: *"Paths through this
 * entity in either role, with Expand"* — this entity's own Network (a Path it
 * is the ROOT of, exactly what the Supplier page's Network section already
 * draws for a Profile) alongside every Path some OTHER entity's Network
 * reaches THIS one through (a Path it is only the TERMINAL of — e.g. this
 * entity is a Family member, or a Listed entity, on somebody else's walk).
 * `loadPathsThroughEntity` (`src/db/queries/family-paths.ts`) is the
 * either-role query; `data.pathRoots` is that query's own root PLUS one hub
 * per distinct other root a `'terminal'`-role Path names, computed once in
 * the loader (`entity-page.ts`'s own "a section receives already-derived
 * props" rule).
 *
 * The diagram is the primary view (spec §8); the chain rows below it are the
 * fallback without scripts and what a citation resolves through — same
 * relationship the Supplier page's `NetworkMap`/`FamilyChainRows` pair has,
 * adapted here for a Path that can run in either direction rather than
 * always outward from one root.
 */
export function PathsThroughEntity({ data, programId }: { data: Data; programId: string }) {
  const { paths, pathRoots } = data;
  return (
    <>
      <h2>
        Paths through this entity <span className="note">{paths.length} stored</span>
      </h2>
      {paths.length === 0 ? (
        <div className="card">
          <p className="empty" style={{ margin: 0 }}>
            No Path stored yet — neither this entity’s own Network, nor another entity’s Network,
            reaches here. Tap Expand on a Network diagram elsewhere to start a Deep Traversal that
            might.
          </p>
        </div>
      ) : (
        <>
          <NetworkMapWithExpand roots={pathRoots} paths={paths} programId={programId} />
          <PathThroughEntityChainRows paths={paths} programId={programId} />
        </>
      )}
    </>
  );
}

/**
 * The citable chain beneath the diagram above, adapted from the Supplier
 * page's `FamilyChainRows` (`.../supplier/[supplierId]/sections.tsx`, network
 * spec §6, §8) for an either-role Path: **Kind** and **Direction** columns
 * stand in for that table's implicit "always downward family, always from the
 * root" assumption, and **Other party** names whichever end is NOT this
 * entity — the far end of the Network for a `'root'`-role row, the Network's
 * own root for a `'terminal'`-role one. The per-edge repeat-blank-until-a-new-
 * Path convention (a cell fills only on a Path's first edge row) is
 * unchanged.
 */
function PathThroughEntityChainRows({
  paths,
  programId,
}: {
  paths: Data['paths'];
  programId: string;
}) {
  return (
    <details className="card scroll-x" style={{ marginTop: '0.6rem' }}>
      <summary>Chain rows — every cited edge these Paths hold</summary>
      <table>
        <thead>
          <tr>
            <th>Kind</th>
            <th>Direction</th>
            <th>Other party</th>
            <th>Edge type</th>
            <th className="num">Share</th>
            <th>From</th>
            <th>To</th>
            <th>Record</th>
          </tr>
        </thead>
        <tbody>
          {paths.map((path) => {
            // The far end is whichever id is NOT this entity — the query's
            // own `role` says which of `terminalEntityId`/`rootEntityId`
            // that is (`loadPathsThroughEntity`'s own doc comment).
            const otherPartyId = path.role === 'root' ? path.terminalEntityId : path.rootEntityId;
            const otherPartyLabel = path.role === 'root' ? path.label : path.rootLabel;
            const direction = path.role === 'root' ? 'from this entity' : 'to this entity';
            const rowKey = `${path.kind}-${path.role}-${path.rootEntityId}-${path.terminalEntityId}`;

            if (path.edges.length === 0) {
              // A migrated row, or one whose edge upsert has not landed yet —
              // `FamilyChainRows`'s own documented gap, same treatment.
              return (
                <tr key={rowKey}>
                  <td className="note">{path.kind.replace(/_/g, ' ')}</td>
                  <td className="note">{direction}</td>
                  <td>
                    <Link href={`/program/${programId}/entity/${otherPartyId}` as never}>
                      {otherPartyLabel}
                    </Link>
                  </td>
                  <td className="note" colSpan={5}>
                    no citable edge yet
                  </td>
                </tr>
              );
            }

            return path.edges.map((edge, i) => (
              <tr key={edge.id}>
                <td className="note">{i === 0 ? path.kind.replace(/_/g, ' ') : ''}</td>
                <td className="note">{i === 0 ? direction : ''}</td>
                <td>
                  {i === 0 ? (
                    <Link href={`/program/${programId}/entity/${otherPartyId}` as never}>
                      {otherPartyLabel}
                    </Link>
                  ) : null}
                </td>
                <td className="note">{edge.relationshipType.replace(/_/g, ' ')}</td>
                <td className="num">
                  {edge.sharePercentage != null ? `${edge.sharePercentage}%` : '—'}
                </td>
                <td className="note">{edge.startDate ?? '—'}</td>
                <td className="note">{edge.endDate ?? '—'}</td>
                <td>
                  {edge.sourceRecordId ? (
                    <Link href={recordHref(programId, edge.sourceRecordId) as never}>record</Link>
                  ) : (
                    <span className="note">—</span>
                  )}
                </td>
              </tr>
            ));
          })}
        </tbody>
      </table>
    </details>
  );
}

/** Matches the Supplier page's own `recordHref` exactly (`.../supplier/[supplierId]/sections.tsx`) — a record id is itself a `/`-joined path, so the catch-all segment is built the same way, encoded per-part. */
function recordHref(programId: string, recordId: string): string {
  return `/program/${programId}/record/${recordId.split('/').map(encodeURIComponent).join('/')}`;
}

/** ── Relationships ── */
export function Relationships({ data }: { data: Data }) {
  const { edges, edgeGroups: groups, owners } = data;
  return (
    <>
      {/*
        The graph, grouped by relationship type and direction.
        `entity_relationship` held zero rows until the projection was fixed: the
        payload keys these under `types` (plural, an object) and the reader
        asked for `type`, so every edge was silently dropped.
      */}
      <h2>
        Relationships{' '}
        <span className="note">
          {edges.length.toLocaleString('en-US')} stored, as the source states them
        </span>
      </h2>
      {edges.length === 0 ? (
        <div className="card">
          <p className="note" style={{ margin: 0 }}>
            No edges stored for this company. That is not the same as a company with no
            relationships — this one has no payload of its own, so nothing has read its graph yet.
          </p>
        </div>
      ) : (
        <div className="card scroll-x">
          <table>
            <thead>
              <tr>
                <th>Relationship</th>
                <th>Direction</th>
                <th className="num">Edges</th>
                <th>Current / former</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <tr key={`${group.relationshipType}-${group.side}`}>
                  <td>{group.relationshipType.replace(/_/g, ' ')}</td>
                  <td className="note">{group.reading}</td>
                  <td className="num">{group.total.toLocaleString('en-US')}</td>
                  <td className="note">
                    {group.current.toLocaleString('en-US')} current
                    {group.former > 0 ? ` · ${group.former.toLocaleString('en-US')} former` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {owners.length > 0 ? (
        <div className="card scroll-x" style={{ marginTop: '1rem' }}>
          <p className="note" style={{ marginTop: 0 }}>
            Current owners, with the share and dates the edge carries — where the source states
            them.
          </p>
          <table>
            <thead>
              <tr>
                <th>Owner</th>
                <th>Relationship</th>
                <th className="num">Share</th>
                <th>From</th>
                <th>To</th>
              </tr>
            </thead>
            <tbody>
              {owners.map((owner) => (
                <tr key={`${owner.relationshipType}-${owner.targetId}`}>
                  <td>{owner.targetLabel ?? owner.targetId}</td>
                  <td className="note">{owner.relationshipType.replace(/_/g, ' ')}</td>
                  <td className="num">
                    {owner.sharePercentage != null ? `${owner.sharePercentage}%` : '—'}
                  </td>
                  <td className="note">{owner.startDate ?? '—'}</td>
                  <td className="note">{owner.endDate ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}

/** ── The payload, so every figure above can be checked against it ── */
export function SourcePayload({
  data,
  programId,
  entityId,
}: {
  data: Data;
  programId: string;
  entityId: string;
}) {
  const { source } = data;
  return (
    <>
      <h2>Source payload</h2>
      <div className="card">
        {source ? (
          <>
            <p className="note" style={{ marginTop: 0 }}>
              Fetched from <span className="mono">{source.endpoint}</span> on{' '}
              {source.fetchedAt.toISOString().slice(0, 10)}
              {source.via ? ` · ${source.via}` : ''}. Everything above is a projection of this.
            </p>
            <details>
              <summary style={{ cursor: 'pointer' }} className="note">
                Show the raw response
              </summary>
              <pre className="mono scroll-x" style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>
                {JSON.stringify(source.body, null, 2)}
              </pre>
            </details>
          </>
        ) : (
          <>
            <p className="note" style={{ marginTop: 0 }}>
              {/*
                Null is the common case and it means something specific, so it is
                written out rather than shown as an empty panel.
              */}
              This company was never fetched on its own — it was seen inside another company&rsquo;s
              response, so there is no payload that belongs to it. What is stored above came from
              that other response, and its relationships have never been read.
            </p>
            <form action={fetchOwnRecord}>
              <input type="hidden" name="programId" value={programId} />
              <input type="hidden" name="entityId" value={entityId} />
              <button
                type="submit"
                className="badge"
                style={{ cursor: 'pointer', padding: '0.45rem 0.8rem' }}
              >
                Fetch this company&rsquo;s own record
              </button>
              <span className="note" style={{ marginLeft: '0.6rem' }}>
                {/*
                  One company, because a person asked. Queueing these
                  automatically the moment one was seen would have cost 4,448
                  calls — about seven times every Sayari call this project has
                  made — mostly for companies nobody opens.
                */}
                One Sayari call, and it runs no model. It reads this company&rsquo;s relationships
                too.
              </span>
            </form>
          </>
        )}
      </div>
    </>
  );
}

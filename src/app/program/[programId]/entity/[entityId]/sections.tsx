import { Breadcrumb } from '@/components/breadcrumb';
import type { loadEntityPage } from '@/db/queries/entity-page';
import {
  effectiveLevel,
  isCountryDerived,
  isTwinFactor,
  variantOf,
} from '@/domain/scoring/risk-factors';
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
  const { entity, program } = data;
  return (
    <>
      <Breadcrumb
        trail={[
          { label: program?.name ?? 'Program', href: `/program/${programId}` },
          { label: entity.label },
        ]}
      />
      <h1>{entity.label}</h1>
      <p className="sub">
        <span className="mono">{entity.id}</span>
        {entity.country ? ` · ${entity.country}` : ''}
        {entity.lei ? ` · LEI ${entity.lei}` : ' · no LEI'}
      </p>
    </>
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
    </tr>
  );
}

/** ── Relationships ── */
export function Relationships({ data }: { data: Data }) {
  const { edges, edgeGroups: groups } = data;
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

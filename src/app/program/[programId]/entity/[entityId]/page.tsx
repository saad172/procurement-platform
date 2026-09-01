import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq, or } from 'drizzle-orm';
import { getPooledDb } from '@/db/client';
import * as t from '@/db/schema';
import { Breadcrumb } from '@/components/breadcrumb';
import { ChatDock } from '@/components/chat-dock';
import { parseRiskObject, effectiveLevel, isCountryDerived, isTwinFactor, variantOf } from '@/domain/scoring/risk-factors';
import { directionOf } from '@/domain/relationships';
import { fetchOwnRecord } from './entity-actions';

/**
 * The Sayari entity page (SPEC §13.1, §13.7) — level four of the spine.
 *
 * **Reached from the Assessment, not only from a menu**: clicking a Citation's
 * `❡` navigates here, because a Citation is a hop rather than a tooltip. A
 * tooltip would make the evidence something you glance at; a page makes it
 * somewhere you can stand.
 *
 * The risk table is the interesting part, because it shows *how each factor was
 * treated* rather than only that it exists — which variant it carries, whether
 * it deducted, and if not, why not.
 */
export default async function EntityPage({
  params,
}: {
  params: Promise<{ programId: string; entityId: string }>;
}) {
  const { programId, entityId } = await params;
  const db = getPooledDb();

  const entity = await db.query.entity.findFirst({ where: eq(t.entity.id, entityId) });
  if (!entity) notFound();

  const program = await db.query.program.findFirst({ where: eq(t.program.id, programId) });
  const edges = await db
    .select()
    .from(t.entityRelationship)
    .where(or(eq(t.entityRelationship.fromEntityId, entityId), eq(t.entityRelationship.toEntityId, entityId)));

  /**
   * The body this row was projected from, when this company was fetched on its
   * own. Most were not — they arrived nested in somebody else's traversal — and
   * that absence is stated rather than left as an empty panel.
   */
  const source = entity.upstreamResponseId
    ? await db.query.upstreamResponse.findFirst({
        where: eq(t.upstreamResponse.id, entity.upstreamResponseId),
      })
    : undefined;

  const sources = readSources(entity.sourceCount);
  const factors = parseRiskObject(entity.risk);

  return (
    <main>
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

      <div className="grid two">
        <section className="card">
          <h3 style={{ marginTop: 0 }}>Attributes</h3>
          <table>
            <tbody>
              <tr><td>Type</td><td>{entity.entityType ?? '—'}</td></tr>
              <tr><td>Address</td><td>{entity.addressLine ?? '—'}</td></tr>
              <tr><td>City</td><td>{entity.city ?? '—'}</td></tr>
              <tr><td>Postcode</td><td className="mono">{entity.postcode ?? '—'}</td></tr>
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
                  {!entity.sanctioned && !entity.pep && !entity.closed ? <span className="note">none</span> : null}
                </td>
              </tr>
            </tbody>
          </table>
        </section>

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
              The returned window was smaller than these counts, so the graph read here is incomplete
              by construction — which is a different thing from an absent relationship.
            </p>
          ) : null}
          <p className="note">{edges.length} edge(s) stored locally.</p>
        </section>
      </div>

      {/*
        `sourceCount` is an object keyed by source hash, and each value carries
        the source's own label, country and kind. The page counted the keys and
        showed the total — the names of the sources a company is known from were
        stored on every row and displayed nowhere.
      */}
      <h2>
        Sources{' '}
        <span className="note">
          {sources.length} distinct, {sources.reduce((sum, s) => sum + s.count, 0).toLocaleString('en-US')}{' '}
          mentions in total
        </span>
      </h2>
      {sources.length === 0 ? (
        <div className="card">
          <p className="note" style={{ margin: 0 }}>No source breakdown stored for this company.</p>
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
              {factors.map((factor) => {
                const scored = effectiveLevel(factor);
                const variant = variantOf(factor.name);
                const twin = isTwinFactor(factor.name);
                const country = isCountryDerived(factor);
                return (
                  <tr key={factor.name}>
                    <td className="mono">{factor.name}</td>
                    <td><span className="badge">{factor.level ?? '—'}</span></td>
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
              })}
            </tbody>
          </table>
        )}
      </div>

      <p className="note" style={{ marginTop: '1rem' }}>
        <Link href={`/program/${programId}` as never}>← back to the program</Link>
      </p>
      {/*
        The graph, grouped by relationship type and direction.
        `entity_relationship` held zero rows until the projection was fixed: the
        payload keys these under `types` (plural, an object) and the reader
        asked for `type`, so every edge was silently dropped.
      */}
      <h2>
        Relationships{' '}
        <span className="note">{edges.length.toLocaleString('en-US')} stored, as the source states them</span>
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
              {groupEdges(edges, entityId).map((group) => (
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

      {/* ── The payload, so every figure above can be checked against it ── */}
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
              <button type="submit" className="badge" style={{ cursor: 'pointer', padding: '0.45rem 0.8rem' }}>
                Fetch this company&rsquo;s own record
              </button>
              <span className="note" style={{ marginLeft: '0.6rem' }}>
                {/*
                  One company, because a person asked. Queueing these
                  automatically the moment one was seen would have cost 4,448
                  calls — about seven times every Sayari call this project has
                  made — mostly for companies nobody opens.
                */}
                One Sayari call, and it runs no model. It reads this
                company&rsquo;s relationships too.
              </span>
            </form>
          </>
        )}
      </div>

      <ChatDock programId={programId} />
    </main>
  );
}

/**
 * Edges grouped for reading, from the perspective of the company on this page.
 *
 * Rows are stored as the payload states them — subject first, target second —
 * so the same row reads differently depending on which end you are standing at.
 * `has_shareholder` on a row where this company is the subject means *somebody
 * owns me*; the identical row seen from the other end means *I own somebody*.
 * Saying which is the entire point of storing direction separately from the
 * name (see `src/domain/relationships.ts`).
 */
function groupEdges(
  edges: (typeof t.entityRelationship.$inferSelect)[],
  entityId: string,
): {
  relationshipType: string;
  side: 'from' | 'to';
  reading: string;
  total: number;
  current: number;
  former: number;
}[] {
  const groups = new Map<string, { type: string; side: 'from' | 'to'; total: number; current: number; former: number }>();

  for (const edge of edges) {
    const side: 'from' | 'to' = edge.fromEntityId === entityId ? 'from' : 'to';
    const key = `${edge.relationshipType}::${side}`;
    const group = groups.get(key) ?? { type: edge.relationshipType, side, total: 0, current: 0, former: 0 };
    group.total += 1;
    if (edge.former) group.former += 1;
    else group.current += 1;
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => {
      const direction = directionOf(group.type);
      // Read from THIS company's end, which flips when it is the target.
      const outward = group.side === 'from';
      const reading =
        direction === 'lateral' ? 'neither owns the other'
        : (direction === 'downward') === outward ? 'this company is above'
        : 'this company is below';
      return { relationshipType: group.type, side: group.side, reading, total: group.total, current: group.current, former: group.former };
    })
    .sort((a, b) => b.total - a.total);
}

/**
 * The sources a company is known from, out of `source_count`.
 *
 * The column is an **object keyed by source hash**, and each value carries the
 * source's label, country and kind. The page has always counted its keys for
 * the data-confidence band and shown nothing else, so a reader could see that a
 * company had 38 distinct sources and never which ones.
 *
 * Sorted by mentions, because *45 rows of trade data and one sanctions listing*
 * is a different company from the reverse, and the order is what says so.
 */
function readSources(
  sourceCount: unknown,
): { hash: string; label: string; country: string; sourceType: string; count: number }[] {
  if (!sourceCount || typeof sourceCount !== 'object') return [];

  return Object.entries(sourceCount as Record<string, unknown>)
    .map(([hash, raw]) => {
      const value = (raw ?? {}) as Record<string, unknown>;
      return {
        hash,
        label: typeof value['label'] === 'string' ? value['label'] : hash.slice(0, 12),
        country: typeof value['country'] === 'string' ? value['country'] : '—',
        sourceType: typeof value['source_type'] === 'string' ? value['source_type'] : 'unknown',
        count: typeof value['count'] === 'number' ? value['count'] : 0,
      };
    })
    .sort((a, b) => b.count - a.count);
}

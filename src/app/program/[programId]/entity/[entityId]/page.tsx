import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq, or } from 'drizzle-orm';
import { getPooledDb } from '@/db/client';
import * as t from '@/db/schema';
import { Breadcrumb } from '@/components/breadcrumb';
import { ChatDock } from '@/components/chat-dock';
import { parseRiskObject, effectiveLevel, isCountryDerived, isTwinFactor, variantOf } from '@/domain/scoring/risk-factors';

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

  const factors = parseRiskObject(entity.risk);

  return (
    <main>
      <Breadcrumb
        trail={[
          { label: program?.name ?? 'Programme', href: `/program/${programId}` },
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
              <tr><td>Address</td><td>{entity.addressLine ?? '—'}</td></tr>
              <tr><td>City</td><td>{entity.city ?? '—'}</td></tr>
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
        <Link href={`/program/${programId}` as never}>← back to the programme</Link>
      </p>
      <ChatDock programId={programId} />
    </main>
  );
}

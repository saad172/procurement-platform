import Link from 'next/link';
import { notFound } from 'next/navigation';
import { desc, eq, inArray } from 'drizzle-orm';
import { getPooledDb } from '@/db/client';
import * as t from '@/db/schema';
import { Breadcrumb } from '@/components/breadcrumb';
import { IDENTITY_STANDARD, IDENTITY_TRAPS } from '@/config/constants';
import { settleByHand } from './actions';

/**
 * Needs Review (SPEC §6.8) — a branch off the Programme page.
 *
 * **Cached-first, expensive-on-demand.** Everything on this page is already
 * stored: the legal name, every address with its three rung verdicts, the LEI
 * or "none", company type and status, the alias list, the source count.
 * Anything beyond that is a request behind the confirm-and-meter gate, because
 * a review page that spends credits on being *opened* would charge for
 * curiosity.
 *
 * The `IDENTITY_STANDARD` is quoted **verbatim** here, the same sentence the
 * resolver and evaluator prompts carry — so a person and two agents are all
 * arguing about the same thing.
 */
export default async function NeedsReviewPage({
  params,
}: {
  params: Promise<{ programId: string }>;
}) {
  const { programId } = await params;
  const db = getPooledDb();

  const program = await db.query.program.findFirst({ where: eq(t.program.id, programId) });
  if (!program) notFound();

  const parked = await db
    .select({ supplier: t.supplier, match: t.match })
    .from(t.supplier)
    .innerJoin(t.match, eq(t.match.supplierId, t.supplier.id))
    .where(eq(t.supplier.programId, programId));

  const waiting = parked.filter((row) => row.match.status !== 'accepted');

  const attempts = waiting.length
    ? await db
        .select()
        .from(t.matchAttempt)
        .where(inArray(t.matchAttempt.matchId, waiting.map((w) => w.match.id)))
        .orderBy(desc(t.matchAttempt.attemptN))
    : [];

  const candidates = attempts.length
    ? await db
        .select({ candidate: t.matchCandidate, entity: t.entity })
        .from(t.matchCandidate)
        .innerJoin(t.entity, eq(t.entity.id, t.matchCandidate.entityId))
        .where(inArray(t.matchCandidate.matchAttemptId, attempts.map((a) => a.id)))
    : [];

  const verdicts = candidates.length
    ? await db
        .select()
        .from(t.matchCandidateVerdict)
        .where(inArray(t.matchCandidateVerdict.matchCandidateId, candidates.map((c) => c.candidate.id)))
    : [];

  return (
    <main>
      <Breadcrumb
        trail={[{ label: program.name, href: `/program/${programId}` }, { label: 'Needs review' }]}
      />
      <h1>Needs review</h1>
      <p className="sub">
        {waiting.length} supplier{waiting.length === 1 ? '' : 's'} the agents could not settle. A parked
        row never stalls a run — everything else finishes without it.
      </p>

      <section className="card">
        <h3 style={{ marginTop: 0 }}>The standard you are applying</h3>
        {/* Quoted verbatim, the same sentence both agents were given. */}
        <p style={{ marginBottom: '0.5rem' }}>{IDENTITY_STANDARD}</p>
        <ul style={{ margin: 0, paddingLeft: '1.1rem' }} className="note">
          {IDENTITY_TRAPS.map((trap) => (
            <li key={trap}>{trap}</li>
          ))}
        </ul>
      </section>

      {waiting.length === 0 ? (
        <p className="empty card" style={{ marginTop: '1rem' }}>
          Nothing is waiting on you.
        </p>
      ) : (
        waiting.map(({ supplier, match }) => {
          const rowAttempts = attempts.filter((a) => a.matchId === match.id);
          const rowCandidates = candidates.filter((c) =>
            rowAttempts.some((a) => a.id === c.candidate.matchAttemptId),
          );

          return (
            <section key={supplier.id} className="card" style={{ marginTop: '1rem' }}>
              <h2 style={{ marginTop: 0 }}>{supplier.rosterName}</h2>
              <p className="note">
                Roster row {supplier.rosterIndex} · {supplier.rosterAddress} · {supplier.rosterCountry}
                {' · '}
                <span className={`badge ${match.status === 'needs_review' ? 'warn' : 'bad'}`}>
                  {match.status.replace(/_/g, ' ')}
                </span>
              </p>
              <p className="note">
                {/*
                  The two parked states mean different things: `needs review`
                  says a candidate in-country was seen and a person can choose;
                  `not found` says none ever was.
                */}
                {match.status === 'needs_review'
                  ? 'A candidate in this country was seen, so there is something to choose between.'
                  : 'No candidate in this country was ever seen. Searching by hand may still find one.'}
              </p>

              {rowCandidates.length > 0 ? (
                <div className="scroll-x">
                  <table>
                    <thead>
                      <tr>
                        <th>Candidate</th>
                        <th>Country</th>
                        <th>LEI</th>
                        <th>Discriminators</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rowCandidates.map(({ candidate, entity }) => {
                        const rowVerdicts = verdicts.filter((v) => v.matchCandidateId === candidate.id);
                        return (
                          <tr key={candidate.id}>
                            <td>
                              <Link href={`/program/${programId}/entity/${entity.id}` as never}>
                                {entity.label}
                              </Link>
                              <div className="note">
                                found by {candidate.foundByRung}
                                {candidate.queryProvenance ? ` — ${candidate.queryProvenance}` : ''}
                              </div>
                            </td>
                            <td>{entity.country ?? '—'}</td>
                            <td className="mono">{entity.lei ?? 'none'}</td>
                            <td>
                              {/*
                                All eight, with `unavailable` visibly distinct
                                from `fail` — absent evidence is not contrary
                                evidence, and the page must not blur them.
                              */}
                              <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
                                {rowVerdicts.map((verdict) => (
                                  <span
                                    key={verdict.id}
                                    className={`badge ${verdict.verdict === 'pass' ? 'good' : verdict.verdict === 'fail' ? 'bad' : 'mute'}`}
                                    title={verdict.reasoning}
                                  >
                                    {verdict.discriminator}
                                    {verdict.verdict === 'unavailable' ? ' · can’t tell' : ''}
                                  </span>
                                ))}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="note">No candidates were recorded for this row.</p>
              )}

              <form action={settleByHand} style={{ marginTop: '1rem', display: 'grid', gap: '0.5rem', maxWidth: '34rem' }}>
                <input type="hidden" name="supplierId" value={supplier.id} />
                <input type="hidden" name="programId" value={programId} />
                <label className="note" htmlFor={`entity-${supplier.id}`}>
                  Settle on a Sayari entity id, or leave blank to mark it not found
                </label>
                <input
                  id={`entity-${supplier.id}`}
                  name="entityId"
                  className="mono"
                  placeholder="entity id"
                  style={{ padding: '0.4rem', border: '1px solid var(--rule)', borderRadius: 4 }}
                />
                <input
                  name="note"
                  placeholder="Why — stored as a human round on the record"
                  style={{ padding: '0.4rem', border: '1px solid var(--rule)', borderRadius: 4 }}
                />
                <button type="submit" className="badge" style={{ cursor: 'pointer', padding: '0.4rem 0.8rem' }}>
                  Settle
                </button>
                <p className="note" style={{ margin: 0 }}>
                  Settling appends a new attempt rather than replacing the last one, so an override
                  after an agent accept shows both. It starts a new run, so the enrichment it unblocks
                  is attributable to your decision.
                </p>
              </form>
            </section>
          );
        })
      )}
    </main>
  );
}

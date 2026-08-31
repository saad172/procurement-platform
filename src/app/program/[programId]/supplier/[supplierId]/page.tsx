import Link from 'next/link';
import { notFound } from 'next/navigation';
import { and, desc, eq } from 'drizzle-orm';
import { getPooledDb } from '@/db/client';
import * as t from '@/db/schema';
import { Breadcrumb } from '@/components/breadcrumb';
import { ChatDock } from '@/components/chat-dock';
import { CriterionCell } from '@/components/criterion-cell';
import { WeightRail } from '@/components/weight-rail';
import { loadEnrichments } from '@/db/queries/enrichments';
import { loadSupplierSnapshots, scoreSnapshot } from '@/db/queries/shortlist';
import { computeFamilyExposure, describeFamilyExposure, unionRiskFactors } from '@/domain/family';
import { DEFAULT_WEIGHTS } from '@/domain/score';
import { SupplierActions } from './supplier-actions';
import { parseViewState } from '@/lib/view-state';

/**
 * The Supplier page (SPEC §13.1) — level three, and **one long scroll**.
 *
 * Score breakdown, location, ownership, family, enrichments, Assessment, Trace,
 * in that order, so **an Assessment and the Trace that produced it read in one
 * pass**. That is why the spine is navigation rather than stacked columns: a
 * column would cap this pane at a column's width, and these are the widest
 * things in the application.
 */
export default async function SupplierPage({
  params,
  searchParams,
}: {
  params: Promise<{ programId: string; supplierId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { programId, supplierId } = await params;
  const query = await searchParams;
  const db = getPooledDb();

  const program = await db.query.program.findFirst({
    where: eq(t.program.id, programId),
    with: { weights: true },
  });
  const supplier = await db.query.supplier.findFirst({
    where: eq(t.supplier.id, supplierId),
    with: { categories: { with: { category: true } } },
  });
  if (!program || !supplier) notFound();

  const programDefault = {
    ...DEFAULT_WEIGHTS,
    ...Object.fromEntries(program.weights.map((w) => [w.criterionKey, Number(w.weight)])),
  };
  const view = parseViewState(query, programDefault);

  const match = await db.query.match.findFirst({
    where: eq(t.match.supplierId, supplierId),
    with: { entity: true, attempts: { orderBy: [desc(t.matchAttempt.attemptN)] } },
  });

  // Read the STORED criterion values, so the page renders what a Citation
  // points at rather than a recomputation that could differ from it.
  const [snapshot] = await loadSupplierSnapshots(db, { programId, supplierIds: [supplierId] });
  const scored = snapshot ? scoreSnapshot(snapshot, view.weights, null) : undefined;

  const familyRows = match?.entityId
    ? await db
        .select({ member: t.entity, hopDepth: t.familyMember.hopDepth })
        .from(t.familyMember)
        .innerJoin(t.entity, eq(t.entity.id, t.familyMember.memberEntityId))
        .where(eq(t.familyMember.rootEntityId, match.entityId))
    : [];

  const exposure = computeFamilyExposure(
    familyRows.map((row) => ({
      entityId: row.member.id,
      label: row.member.label,
      country: row.member.country,
      factors: unionRiskFactors([{ source: 'getEntity', risk: row.member.risk }]).map((u) => u.factor),
      fromDeepTraversal: false,
    })),
    { explored: familyRows.length, reachable: null },
  );

  // Ages are computed in the query, not during render: reading a clock while
  // rendering is not idempotent, and one read per request is the right number.
  const enrichments = await loadEnrichments(db, match?.entityId ?? supplierId);

  const assessment = await db.query.assessment.findFirst({
    where: and(eq(t.assessment.supplierId, supplierId), eq(t.assessment.kind, 'standard')),
    with: { versions: { orderBy: [desc(t.assessmentVersion.n)], limit: 1 } },
  });
  const version = assessment?.versions[0];
  const sentences = version
    ? await db
        .select()
        .from(t.sentence)
        .where(eq(t.sentence.assessmentVersionId, version.id))
        .orderBy(t.sentence.section, t.sentence.ordinal)
    : [];
  const dissent = version
    ? await db
        .select()
        .from(t.round)
        .where(eq(t.round.assessmentVersionId, version.id))
    : [];

  return (
    <main>
      <Breadcrumb
        trail={[
          { label: program.name, href: `/program/${programId}` },
          { label: supplier.rosterName ?? '(promoted lead)' },
        ]}
      />
      <h1>{supplier.rosterName ?? match?.entity?.label ?? 'Promoted lead'}</h1>
      <p className="sub">
        {/*
          A promoted Lead renders "Identity: discovered", NEVER "verified" — no
          name matching happened for it to be strong or weak at.
        */}
        {match ? (
          <>
            Identity: <strong>{match.settledBy === 'discovered' ? 'discovered' : match.status.replace(/_/g, ' ')}</strong>
            {match.settledBy !== 'discovered' ? ` · settled by ${match.settledBy}` : ''}
            {match.entity ? ` · ${match.entity.label}` : ''}
          </>
        ) : (
          'Not yet resolved'
        )}
      </p>

      <SupplierActions
        programId={programId}
        supplierId={supplierId}
        hasMatch={match?.status === 'accepted'}
        hasScore={scored?.score != null}
      />

      {/* ── Score breakdown ── */}
      <h2>Score</h2>
      <div className="grid two">
        <div className="card">
          {scored?.score == null ? (
            <>
              <p style={{ marginTop: 0 }}>
                <strong>No score.</strong>{' '}
                {/*
                  Three reasons a score is absent, and they are not the same
                  news. The third — settled, categorised, but nothing fetched —
                  used to render as "its match is not settled" directly beneath
                  a heading reading "accepted", which told the reader the one
                  thing about this page that was false.
                */}
                {scored?.scoreAbsentReason === 'no_category'
                  ? 'This supplier bids on no category in this programme, so it reaches no shortlist. It still carries criterion values and an assessment.'
                  : scored?.scoreAbsentReason === 'no_match'
                    ? 'Its match is not settled, so there is no profile to measure — and no estimated criterion is shown, because a number about a company we have not identified would be worse than none.'
                    : 'Its match is settled, but no criterion has a value yet — nothing has been enriched, so every weight dropped out and there is nothing left to average. Re-enrich fetches the six sources a score is computed from.'}
              </p>
              {match?.status !== 'accepted' && match?.attempts.length ? (
                <p className="note">
                  <Link href={`/program/${programId}/needs-review` as never}>
                    See the resolver’s candidates and rounds
                  </Link>
                </p>
              ) : null}
            </>
          ) : (
            <>
              <p style={{ marginTop: 0, fontSize: '2rem', fontWeight: 650, lineHeight: 1 }}>
                {scored.score.toFixed(1)}
              </p>
              <p className="note">
                {scored.coverage.computed} of {scored.coverage.total} criteria returned a value —
                the rest dropped out and the weights renormalised. Coverage is shown wherever a score
                is, because a score over five criteria is not the same claim as one over six.
              </p>
              {scored.disqualifying ? (
                <p><span className="badge bad">disqualifying factor</span></p>
              ) : null}
            </>
          )}
        </div>
        <WeightRail programDefault={programDefault} live={scored?.score != null} />
      </div>

      {scored ? (
        <div className="card scroll-x" style={{ marginTop: '1rem' }}>
          {/* Sorted by CONTRIBUTION, so what moved the number reads first. */}
          <table>
            <thead>
              <tr>
                <th>Criterion</th>
                <th>Value, and what it was computed from</th>
                <th className="num">Weight</th>
                <th className="num">Contribution</th>
              </tr>
            </thead>
            <tbody>
              {scored.criteria.map((criterion) => (
                <tr key={criterion.key}>
                  <td>{criterion.key.replace(/_/g, ' ')}</td>
                  <td><CriterionCell criterion={criterion} /></td>
                  <td className="num">
                    {criterion.effectiveWeight === 0 ? (
                      <span className="note">not scored</span>
                    ) : (
                      criterion.effectiveWeight.toFixed(1)
                    )}
                  </td>
                  <td className="num">
                    {criterion.contribution === 0 ? '—' : criterion.contribution.toFixed(1)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {/* ── Corporate family ── */}
      <h2>Corporate family</h2>
      <div className="card">
        <p style={{ marginTop: 0 }}>
          <span
            className={`badge ${exposure.state === 'exposure_found' ? 'bad' : exposure.state === 'no_exposure_found' ? 'good' : 'mute'}`}
          >
            {describeFamilyExposure(exposure)}
          </span>
        </p>
        {exposure.state === 'exposure_found' ? (
          <>
            <p className="note">
              {/*
                The rule stated where it bites: a family member's risk BADGES and
                never deducts, so this changes no rank. A supplier whose
                subsidiary carries high forced-labour exposure can still be
                awarded — it shows a cut score and a lit badge, and is not
                blocked.
              */}
              A family member’s risk badges and never deducts, so nothing here moved this supplier’s
              rank. Each finding is cited to the member’s own entity, not to the parent’s.
            </p>
            <table>
              <tbody>
                {exposure.members.map((member) => (
                  <tr key={member.entityId}>
                    <td>
                      <Link href={`/program/${programId}/entity/${member.entityId}` as never}>
                        {member.label}
                      </Link>
                    </td>
                    <td><span className="badge warn">{member.level}</span></td>
                    <td className="note">{member.factors.slice(0, 3).join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : (
          <p className="note" style={{ margin: 0 }}>
            {exposure.state === 'not_covered'
              ? 'The ownership graph returned nobody. That is not the same as a clean family — six of twelve sampled families returned zero members, including several that certainly have subsidiaries.'
              : 'Members came back carrying nothing. The read is capped at 50 nodes, so an absent member proves nothing.'}
          </p>
        )}
      </div>

      {/* ── Enrichments ── */}
      <h2>Enrichments</h2>
      <div className="card scroll-x">
        {enrichments.length === 0 ? (
          <p className="empty">Nothing fetched yet.</p>
        ) : (
          <table>
            <thead>
              <tr><th>Source</th><th>Subject</th><th>Fetched</th><th>Age</th></tr>
            </thead>
            <tbody>
              {enrichments.map((enrichment) => (
                <tr key={enrichment.id}>
                  <td>{enrichment.source.replace(/_/g, ' ')}</td>
                  <td className="mono">{enrichment.subjectKey.slice(0, 28)}</td>
                  <td className="note">{enrichment.fetchedAt.toISOString().slice(0, 10)}</td>
                  <td>
                    {/*
                      An age badge, not a refresh trigger. There is no TTL and no
                      background refresh: a background TTL would spend credits on
                      page views. An aged fact forces a caveat line instead.
                    */}
                    <AgeBadge ageDays={enrichment.ageDays} needsCaveat={enrichment.needsCaveat} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Assessment ── */}
      <h2>Assessment</h2>
      <div className="card">
        {!version ? (
          <p className="empty">No assessment has been written for this supplier yet.</p>
        ) : (
          <>
            <p style={{ marginTop: 0 }}>
              Version {version.n} ·{' '}
              <span className={`badge ${version.evaluatorOutcome === 'passed' ? 'good' : 'warn'}`}>
                {version.evaluatorOutcome.replace(/_/g, ' ')}
              </span>{' '}
              {version.verdict ? <span className="badge">{version.verdict.replace(/_/g, ' ')}</span> : null}
            </p>
            {groupBySection(sentences).map(([section, rows]) => (
              <section key={section} style={{ marginTop: '1rem' }}>
                <h3 style={{ marginTop: 0 }}>{section.replace(/_/g, ' ')}</h3>
                {rows.map((sentence) => (
                  <p key={sentence.id} style={{ margin: '0 0 0.5rem' }}>
                    {sentence.text}{' '}
                    {/*
                      A citation is a HOP, not a tooltip: clicking it navigates
                      to the entity, and an attribute's record chip navigates to
                      the record. Level 4 is reached from the Assessment.
                    */}
                    <Link
                      href={`/program/${programId}/supplier/${supplierId}/citation/${sentence.id}` as never}
                      title="Go to the evidence"
                      style={{ textDecoration: 'none' }}
                    >
                      ❡
                    </Link>
                  </p>
                ))}
              </section>
            ))}

            {dissent.some((round) => round.objection) ? (
              <section style={{ marginTop: '1rem' }}>
                <h3>Dissent</h3>
                <p className="note">
                  Nobody writes this section. It is what the disagreement left behind — the objections
                  this version published without resolving, each with the reply it drew.
                </p>
                {dissent
                  .filter((round) => round.objection)
                  .map((round) => (
                    <div key={round.id} style={{ marginBottom: '0.6rem' }}>
                      <p style={{ margin: 0 }}>
                        <span className="badge mute">
                          round {round.n} · {round.source}
                        </span>{' '}
                        {round.objection}
                      </p>
                      {round.reply ? <p className="note" style={{ margin: 0 }}>Reply: {round.reply}</p> : null}
                    </div>
                  ))}
              </section>
            ) : null}
          </>
        )}
      </div>
      <ChatDock programId={programId} />
    </main>
  );
}

function groupBySection(sentences: (typeof t.sentence.$inferSelect)[]) {
  const map = new Map<string, (typeof t.sentence.$inferSelect)[]>();
  for (const sentence of sentences) {
    map.set(sentence.section, [...(map.get(sentence.section) ?? []), sentence]);
  }
  return [...map.entries()];
}

/**
 * The age badge (SPEC §7.2).
 *
 * It reports and never acts: **staleness forces the caveat line rather than
 * blocking anything**, and there is no background refresh because one would
 * spend credits on page views.
 */
function AgeBadge({ ageDays, needsCaveat }: { ageDays: number; needsCaveat: boolean }) {
  if (needsCaveat) return <span className="badge warn">{ageDays}d — cite with a caveat</span>;
  return <span className={`badge ${ageDays < 7 ? 'good' : ''}`}>{ageDays}d</span>;
}

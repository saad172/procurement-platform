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
import { loadShortlist, loadSupplierSnapshots, rankSentence, scoreSnapshot } from '@/db/queries/shortlist';
import { computeFamilyExposure, describeFamilyExposure, unionRiskFactors } from '@/domain/family';
import { DEFAULT_WEIGHTS } from '@/domain/score';
import { supplierAnswer } from '@/domain/supplier-answer';
import { describeSupplier } from '@/domain/supplier-description';
import { entitySchema, type SayariEntity } from '@/upstream/projections/sayari';
import { SupplierActions } from './supplier-actions';
import { parseViewState } from '@/lib/view-state';

/**
 * The Supplier page (SPEC §13.1) — level three, and **one long scroll**.
 *
 * ## Answer first
 *
 * It used to open with its working: score breakdown, weight rail, criteria
 * table, family, enrichments, and only then the Assessment. Measured, that put
 * **"score 30.1" at word 30 with no scale and the verdict `escalate` at word
 * 609 of 2,707**, rendered as a grey badge weighing exactly as much as the word
 * "assessed" beside it. A manager could not tell what was happening.
 *
 * So the order is now the order the questions get asked in:
 *
 * 1. **What is happening and what to do** — one `.answer`, computed in
 *    `supplierAnswer()` so there is exactly one of them and the order the cases
 *    are tested in is written down.
 * 2. **Where it stands** — the figures, each labelled in a buyer's words.
 * 3. **Who it is** — the description, out of facts stored since the first
 *    enrichment and never rendered until the attribute projection was fixed.
 * 4. **What was concluded** — the Assessment prose, with its citation hops.
 * 5. **The working** — the score breakdown, the weights, the family and the
 *    enrichments, demoted into `.working` and never hidden.
 *
 * The spine is still navigation rather than stacked columns: a column would cap
 * this pane at a column's width, and these are the widest things in the app.
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
        .select({
          member: t.entity,
          hopDepth: t.familyMember.hopDepth,
          exploredCount: t.familyMember.exploredCount,
          reachableCount: t.familyMember.reachableCount,
        })
        .from(t.familyMember)
        .innerJoin(t.entity, eq(t.entity.id, t.familyMember.memberEntityId))
        .where(eq(t.familyMember.rootEntityId, match.entityId))
    : [];

  /**
   * **The coverage figures are read, not counted.**
   *
   * `explored_count` is what the traversal itself reported, and counting rows
   * instead answers a different question — how many rows we hold — which is
   * only ever accidentally the same number. It was not: with the family stored
   * twice for Bosch and Magna, the badge read *"28 of 100 explored"* against a
   * truth of 14 of 50. The unique index added alongside this stops the rows
   * doubling; reading the stored figure is what stops a future divergence from
   * being invisible.
   */
  const coverage = {
    explored: familyRows[0]?.exploredCount ?? familyRows.length,
    reachable: familyRows[0]?.reachableCount ?? null,
  };

  const exposure = computeFamilyExposure(
    familyRows.map((row) => ({
      entityId: row.member.id,
      label: row.member.label,
      country: row.member.country,
      factors: unionRiskFactors([{ source: 'getEntity', risk: row.member.risk }]).map((u) => u.factor),
      fromDeepTraversal: false,
    })),
    coverage,
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

  /**
   * **Who this company is**, out of its own stored payload.
   *
   * Every fact in the description has been on disk since the first enrichment
   * ran and none of it reached a page: the attribute projection dropped it
   * (BUILD-NOTES finding 90). It is projected here rather than stored flat
   * because it is a *reading* of the payload — the ranking rule that decides
   * which activity leads is one we may change, and re-deriving it from the
   * cached body costs nothing and spends no credits.
   */
  const ownPayload = match?.entity?.upstreamResponseId
    ? await db.query.upstreamResponse.findFirst({
        where: eq(t.upstreamResponse.id, match.entity.upstreamResponseId),
      })
    : undefined;
  let profile: SayariEntity | undefined;
  if (ownPayload) {
    const parsed = entitySchema.safeParse(ownPayload.body);
    // A body that no longer parses is a projection change, not a page error:
    // the rest of the page is unaffected and the description simply says less.
    if (parsed.success) profile = parsed.data as SayariEntity;
  }
  const described = profile ? describeSupplier(profile) : undefined;

  /**
   * The rank, against the **unfiltered** Shortlist of the first category this
   * Supplier bids on — a Supplier page always states it, whatever a filter is
   * doing above it, because "6th of 9" is the figure that gives a score a scale.
   */
  const firstCategory = supplier.categories[0]?.category;
  const shortlist = firstCategory
    ? await loadShortlist(db, { programId, categoryId: firstCategory.id, weights: view.weights })
    : undefined;
  const rank = shortlist
    ? rankSentence(
        shortlist.ranked.find((row) => row.supplierId === supplierId),
        shortlist.totalCount,
      )
    : 'not ranked';

  /** Risk factors on the company itself, as against on its family. */
  const ownRiskFactors = unionRiskFactors([
    { source: 'getEntity', risk: match?.entity?.risk ?? null },
  ]).length;

  const freshest = enrichments.reduce<number | null>(
    (best, e) => (best == null || e.ageDays < best ? e.ageDays : best),
    null,
  );

  const answer = supplierAnswer({
    name: supplier.rosterName ?? match?.entity?.label ?? 'This supplier',
    match: match
      ? {
          status: match.status,
          settledBy: match.settledBy,
          entityLabel: match.entity?.label ?? null,
        }
      : undefined,
    assessment: version
      ? {
          verdict: version.verdict,
          evaluatorOutcome: version.evaluatorOutcome,
          objections: dissent.map((round) => round.objection).filter((o): o is string => o != null),
        }
      : undefined,
    score: scored?.score ?? null,
    scoreAbsentReason: scored?.scoreAbsentReason,
    disqualifying: scored?.disqualifying ?? false,
    needsReviewHref: `/program/${programId}/needs-review`,
    assessmentHref: '#assessment',
    compareHref: firstCategory ? `/program/${programId}/category/${firstCategory.id}` : null,
    categoryName: firstCategory?.name ?? null,
  });

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
        {supplier.categories.length > 0 ? (
          <>
            Ranked on{' '}
            {supplier.categories.map((row, i) => (
              <span key={row.category.id}>
                {i === 0 ? '' : i === supplier.categories.length - 1 ? ' and ' : ', '}
                <Link href={`/program/${programId}/category/${row.category.id}` as never}>
                  {row.category.name}
                </Link>
              </span>
            ))}
            {' · '}
          </>
        ) : null}
        {/*
          A promoted Lead reads "found by searching", NEVER "verified" — no name
          matching happened for it to be strong or weak at. The canonical terms
          travel under the dotted underline rather than on the surface.
        */}
        {match ? (
          <>
            {match.settledBy === 'discovered' ? (
              <>we found this one by searching, not from the roster</>
            ) : match.status === 'accepted' ? (
              <>
                we believe this is <strong>{match.entity?.label}</strong>
                {match.entity?.city ? `, ${match.entity.city}` : ''}
                {' '}
                {/*
                  Each of the three says something different about who decided,
                  and "settled by agents" on a page that also says "agreed
                  without a model" would be two claims about one fact.
                */}
                <span className="term">
                  {match.settledBy === 'rules'
                    ? 'agreed by the checks alone, with no model involved'
                    : match.settledBy === 'agents'
                      ? 'two independent reads agreed on it'
                      : 'a person decided this'}
                  <i>settled by {match.settledBy}</i>
                </span>
              </>
            ) : (
              <>
                <span className="term">
                  nobody has confirmed which company this is<i>{match.status}</i>
                </span>
              </>
            )}
          </>
        ) : (
          'nothing has been run against this row yet'
        )}
      </p>

      {/* ── The answer, before any of the working ── */}
      <div className={`answer ${answer.tone === 'neutral' ? '' : answer.tone}`}>
        <p className="said">{answer.said}</p>
        <p className="because">{answer.because}</p>
        {answer.actions.length > 0 ? (
          <div className="do">
            {answer.actions
              .filter((action) => action.href)
              .map((action) => (
                <Link
                  key={action.label}
                  className={`btn ${action.primary ? 'primary' : ''}`}
                  href={action.href as never}
                >
                  {action.label}
                </Link>
              ))}
            {/*
              The two actions that SPEND are left to `SupplierActions`, which
              owns the POST and the disabled states. The answer names them; it
              does not grow its own copy of a button that costs credits.
            */}
          </div>
        ) : null}
      </div>

      {/* ── Where it stands ── */}
      <h2>Where {supplier.rosterName ?? 'this supplier'} stands</h2>
      <div className="where">
        <div className={scored?.score == null ? '' : scored.score < 50 ? 'warn' : 'good'}>
          <b>{scored?.score == null ? '—' : scored.score.toFixed(1)}</b>
          <span>fit score out of 100</span>
        </div>
        <div>
          <b>{rank}</b>
          <span>{firstCategory ? `on ${firstCategory.name}` : 'on no category here'}</span>
        </div>
        <div>
          <b>
            {scored ? `${scored.coverage.computed} of ${scored.coverage.total}` : '—'}
          </b>
          <span>things we could measure</span>
        </div>
        <div className={ownRiskFactors > 0 ? 'bad' : ''}>
          <b>{ownRiskFactors}</b>
          <span>risk flags on the company itself</span>
        </div>
        <div className={exposure.state === 'exposure_found' ? 'warn' : ''}>
          <b>
            {exposure.state === 'exposure_found'
              ? `${exposure.membersWithExposure} of ${exposure.explored}`
              : `0 of ${coverage.explored}`}
          </b>
          <span>
            <span className="term">
              group companies carrying risk<i>Corporate family</i>
            </span>
          </span>
        </div>
        <div>
          <b>{freshest == null ? 'never' : freshest === 0 ? 'today' : `${freshest}d`}</b>
          <span>since we last checked</span>
        </div>
      </div>
      {scored?.score != null ? (
        <p className="note" style={{ margin: '-0.9rem 0 1.5rem', maxWidth: '56rem' }}>
          {/*
            The figure most likely to be misread on the page, so it is said
            plainly next to it: a fit score is about this programme, not a
            judgement of the company.
          */}
          A low score is not a verdict on the company — it is a fit for{' '}
          <em>this programme</em>, over the {scored.coverage.computed} criteria that returned a
          value. The rest dropped out and the weights renormalised, because a score over five
          criteria is not the same claim as one over six.
        </p>
      ) : null}

      {/* ── Who it is ── */}
      {described && (described.headline || described.figures.length > 0) ? (
        <>
          <h2>Who {match?.entity?.label ?? 'this company'} is</h2>
          <div className="card">
            {described.headline ? (
              <p style={{ margin: '0 0 0.8rem', fontSize: '1.02rem', maxWidth: '60rem' }}>
                <strong>{described.headline}</strong>
              </p>
            ) : null}
            {described.figures.length > 0 ? (
              <div className="where" style={{ margin: '0 0 0.8rem' }}>
                {described.figures.map((figure) => (
                  <div key={figure.label}>
                    <b>{figure.value}</b>
                    <span>{figure.label}</span>
                  </div>
                ))}
              </div>
            ) : null}
            <p className="note" style={{ margin: 0 }}>
              {described.countries.length > 0 ? (
                <>Operates in {described.countries.join(', ')}. </>
              ) : null}
              {described.trade ? (
                <>
                  <span className="term">
                    Its trade in and out<i>tradeCount</i>
                  </span>{' '}
                  is {described.trade.sent.toLocaleString('en-GB')} shipments sent against{' '}
                  {described.trade.received.toLocaleString('en-GB')} received
                  {described.trade.sent > described.trade.received * 2
                    ? ' — a maker rather than a distributor'
                    : ''}
                  .
                </>
              ) : null}
            </p>
            {described.codes.length > 0 ? (
              <details className="working" style={{ margin: '0.9rem 0 0' }}>
                <summary>
                  The {described.codes.length} activity{' '}
                  {described.codes.length === 1 ? 'code' : 'codes'} this description is built from
                </summary>
                <p className="note" style={{ margin: 0 }}>
                  {described.codes.map((code, i) => (
                    <span key={`${code.code}-${i}`}>
                      {i > 0 ? ' · ' : ''}
                      <span className="mono">{code.code}</span> {code.label}
                      {code.standard ? ` (${code.standard})` : ''}
                    </span>
                  ))}
                  . Filed under each country&rsquo;s own scheme and converted to one standard. The codes
                  disagree on detail and agree on the main point, which is why the description leads
                  with what the most records assert.
                </p>
              </details>
            ) : null}
          </div>
        </>
      ) : null}

      {/* ── What was concluded ── */}
      <h2 id="assessment">
        <span className="term">What the analysis concluded<i>Assessment</i></span>
      </h2>
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
                      to the evidence, and from there to the entity or the
                      record itself. Level 4 is reached from the Assessment.

                      This used to point at
                      `.../supplier/[supplierId]/citation/[sentenceId]`, which
                      was never built — 169 published links, every one a 404.
                      The route lives under the Programme now, because a
                      Citation belongs to a sentence and a sentence already
                      knows whether an Assessment or a Recommendation published
                      it.
                    */}
                    <Link
                      href={`/program/${programId}/citation/${sentence.id}` as never}
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
                <h3>Where the reviewer did not back down</h3>
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
      {/* ── The working ── */}
      <h2>The working</h2>
      <p className="note" style={{ margin: '-0.4rem 0 0.8rem', maxWidth: '56rem' }}>
        Everything the answer above was computed from. None of it is hidden; it is underneath
        because it is what you check rather than what you read.
      </p>

      <SupplierActions
        programId={programId}
        supplierId={supplierId}
        hasMatch={match?.status === 'accepted'}
        hasScore={scored?.score != null}
      />

      <h3>How the score was reached</h3>
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
      <h3>
        <span className="term">Other companies in the group<i>Corporate family</i></span>
      </h3>
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
      <h3>
        <span className="term">What we fetched, and when<i>Enrichments</i></span>
      </h3>
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

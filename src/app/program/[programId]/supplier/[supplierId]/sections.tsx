import Link from 'next/link';
import type * as t from '@/db/schema';
import { Breadcrumb } from '@/components/breadcrumb';
import { CriterionCell } from '@/components/criterion-cell';
import { WeightRail } from '@/components/weight-rail';
import type { loadSupplierPage } from '@/db/queries/supplier-page';
import type { ScoredCriterion } from '@/domain/score';
import { settledByLine } from '@/domain/supplier-answer';
import { SupplierActions } from './supplier-actions';

/**
 * The Supplier page's sections (SPEC §13.1) — one component per `<h2>`, plus
 * the two blocks ahead of the first one: the trail and headline, and the
 * single `.answer` that leads the page.
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
 */
type Data = NonNullable<Awaited<ReturnType<typeof loadSupplierPage>>>;

export function Heading({ data, programId }: { data: Data; programId: string }) {
  const { program, supplier, match } = data;
  return (
    <>
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
                we believe this is{' '}
                {/*
                  A settled Match is a hop, not only a sentence: the Profile's
                  own page carries the ownership, the risk factors and the
                  Twins this line only summarises.
                */}
                {match.entityId ? (
                  <Link href={`/program/${programId}/entity/${match.entityId}` as never}>
                    <strong>{match.entity?.label}</strong>
                  </Link>
                ) : (
                  <strong>{match.entity?.label}</strong>
                )}
                {match.entity?.city ? `, ${match.entity.city}` : ''}{' '}
                {/*
                  settledByLine (domain/supplier-answer.ts) is the one place
                  that decides which of the three sentences this is — shared
                  with the supplier_card chat widget, so "settled by agents"
                  here and "agreed without a model" there can never both be
                  said about the same Match.
                */}
                <span className="term">
                  {settledByLine(match.settledBy)}
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
    </>
  );
}
export function Answer({ data }: { data: Data }) {
  const { answer } = data;
  return (
    <>
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
    </>
  );
}
export function WhereItStands({ data }: { data: Data }) {
  const { supplier, scored, firstCategory, rank, ownRiskFactors, freshest } = data;
  const network = scored?.criteria.find((c) => c.key === 'network_exposure');
  const networkRaw = network ? networkRawInputs(network.outcome.rawInputs) : null;
  return (
    <>
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
          <b>{scored ? `${scored.coverage.computed} of ${scored.coverage.total}` : '—'}</b>
          <span>things we could measure</span>
        </div>
        <div className={ownRiskFactors > 0 ? 'bad' : ''}>
          <b>{ownRiskFactors}</b>
          <span>risk flags on the company itself</span>
        </div>
        <div className={networkRaw && networkRaw.members.length > 0 ? 'warn' : ''}>
          <b>{networkStatLabel(network, networkRaw)}</b>
          <span>
            <span className="term">
              named entities in the network carrying risk<i>Network exposure</i>
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
            plainly next to it: a fit score is about this program, not a
            judgement of the company.
          */}
          A low score is not a verdict on the company — it is a fit for <em>this program</em>, over
          the {scored.coverage.computed} criteria that returned a value. The rest dropped out and
          the weights renormalised, because a score over five criteria is not the same claim as one
          over six.
        </p>
      ) : null}
    </>
  );
}
export function WhoItIs({ data, programId }: { data: Data; programId: string }) {
  const { match, described } = data;
  return (
    <>
      {/* ── Who it is ── */}
      {described && (described.headline || described.figures.length > 0) ? (
        <>
          <h2>
            Who{' '}
            {match?.entityId ? (
              <Link href={`/program/${programId}/entity/${match.entityId}` as never}>
                {match.entity?.label}
              </Link>
            ) : (
              (match?.entity?.label ?? 'this company')
            )}{' '}
            is
          </h2>
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
                  . Filed under each country&rsquo;s own scheme and converted to one standard. The
                  codes disagree on detail and agree on the main point, which is why the description
                  leads with what the most records assert.
                </p>
              </details>
            ) : null}
          </div>
        </>
      ) : null}
    </>
  );
}
export function WhatWasConcluded({ data, programId }: { data: Data; programId: string }) {
  const { version, sentences, dissent } = data;
  return (
    <>
      {/* ── What was concluded ── */}
      <h2 id="assessment">
        <span className="term">
          What the analysis concluded<i>Assessment</i>
        </span>
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
              {version.verdict ? (
                <span className="badge">{version.verdict.replace(/_/g, ' ')}</span>
              ) : null}
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
                      The route lives under the Program now, because a
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
                  Nobody writes this section. It is what the disagreement left behind — the
                  objections this version published without resolving, each with the reply it drew.
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
                      {round.reply ? (
                        <p className="note" style={{ margin: 0 }}>
                          Reply: {round.reply}
                        </p>
                      ) : null}
                    </div>
                  ))}
              </section>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}
export function TheWorking({
  data,
  programId,
  supplierId,
}: {
  data: Data;
  programId: string;
  supplierId: string;
}) {
  const { programDefault, match, scored } = data;
  return (
    <>
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
                  ? 'This supplier is not mapped to any category in this program, so it reaches no shortlist. It still carries criterion values and an assessment.'
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
                the rest dropped out and the weights renormalised. Coverage is shown wherever a
                score is, because a score over five criteria is not the same claim as one over six.
              </p>
              {scored.disqualifying ? (
                <p>
                  <span className="badge bad">disqualifying factor</span>
                </p>
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
                  <td>
                    <CriterionCell criterion={criterion} />
                  </td>
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
    </>
  );
}
/**
 * `network_exposure`'s `rawInputs`, narrowed from `Record<string, unknown>`
 * — the shape is `src/domain/scoring/criteria.ts`'s own doc comment on
 * `networkExposure` (network spec §5, read in full before writing this
 * section), transcribed here as types rather than re-read on every access.
 *
 * A `value` outcome carries every field below; an `unknown` outcome carries
 * at most `familyCoverage`/`watchlistCoverage` (absent on the single earliest
 * exit, an unsettled Match) — never `members`/`shown`/`stateOwnership`, which
 * only exist once the two automatic reads have actually been scored. Every
 * field below defaults rather than assumes presence for exactly that reason.
 */
type NetworkLevel = 'relevant' | 'elevated' | 'high';
type NetworkMemberRaw = {
  entityId: string;
  label: string;
  level: NetworkLevel;
  hopDepth: number;
  hopDiscount: number;
  points: number;
  factors: string[];
  sources: string[];
};
type NetworkShownRaw = {
  entityId: string;
  label: string;
  level: NetworkLevel | null;
  hopDepth: number;
  factors: string[];
  sources: string[];
};
type NetworkStateOwnershipRaw = {
  entityId: string;
  label: string;
  hopDepth: number;
  hopDiscount: number;
  points: number;
};
type NetworkPathCoverageRaw = { exploredCount: number | null; truncated: boolean };
type NetworkRawInputs = {
  members: NetworkMemberRaw[];
  shown: NetworkShownRaw[];
  stateOwnership: NetworkStateOwnershipRaw[];
  worstLevel: NetworkLevel | null;
  familyCoverage: NetworkPathCoverageRaw;
  watchlistCoverage: NetworkPathCoverageRaw;
};
const EMPTY_NETWORK_COVERAGE: NetworkPathCoverageRaw = { exploredCount: null, truncated: false };

function networkRawInputs(raw: Record<string, unknown>): NetworkRawInputs {
  const r = raw as Partial<NetworkRawInputs>;
  return {
    members: r.members ?? [],
    shown: r.shown ?? [],
    stateOwnership: r.stateOwnership ?? [],
    worstLevel: r.worstLevel ?? null,
    familyCoverage: r.familyCoverage ?? EMPTY_NETWORK_COVERAGE,
    watchlistCoverage: r.watchlistCoverage ?? EMPTY_NETWORK_COVERAGE,
  };
}

/** The "N of M" stat tile above (SPEC §13.1 "Where it stands") — never invented from `raw` alone, because an absent Criterion and a genuinely clean one both read as zero. */
function networkStatLabel(
  criterion: ScoredCriterion | undefined,
  raw: NetworkRawInputs | null,
): string {
  if (!criterion) return '—';
  if (criterion.outcome.status === 'unknown') return 'unknown';
  const named = (raw?.members.length ?? 0) + (raw?.shown.length ?? 0);
  return `${raw?.members.length ?? 0} of ${named}`;
}

/** How far the two automatic reads looked, in the reader's own words — never invented from how many entities `members`/`shown` happen to name (this file's own `describeRawInputs` doc, `criterion-cell.tsx`). */
function describeNetworkCoverage(raw: NetworkRawInputs): string {
  return `${oneCoverageSentence('The downward family walk', raw.familyCoverage)} ${oneCoverageSentence('The either-direction watchlist walk', raw.watchlistCoverage)}`;
}

function oneCoverageSentence(label: string, coverage: NetworkPathCoverageRaw): string {
  if (coverage.exploredCount == null) return `${label} has no recorded explored count yet.`;
  const nodes = coverage.exploredCount.toLocaleString('en-GB');
  const cap = coverage.truncated ? ', capped before the end of the graph' : '';
  return `${label} explored ${nodes} node${coverage.exploredCount === 1 ? '' : 's'}${cap}.`;
}

/**
 * The Network section (network spec §8, §9 — replaces the former Corporate
 * family section): `network_exposure`'s own value and band through
 * `CriterionCell` (consistent with the generic criteria table further down,
 * which already renders this Criterion with zero changes needed), then its
 * raw inputs broken out by what each entity did — deducted, state-owned, or
 * named without deducting — because `CriterionCell`'s generic
 * `describeRawInputs` has no branch for this Criterion's own shape and was
 * never meant to (SPEC §9.1's "beside its raw inputs" is earned here, not
 * there).
 */
export function Network({ data, programId }: { data: Data; programId: string }) {
  const { scored } = data;
  const criterion = scored?.criteria.find((c) => c.key === 'network_exposure');
  const raw = criterion ? networkRawInputs(criterion.outcome.rawInputs) : null;

  return (
    <>
      {/* ── Network ── */}
      <h3>
        <span className="term">
          Who else could carry this supplier’s risk<i>Network</i>
        </span>
      </h3>
      <div className="card">
        {!criterion || !raw ? (
          <p className="empty">
            Not scored — this supplier’s match is not settled, so there is no Profile to walk a
            network from.
          </p>
        ) : (
          <>
            <CriterionCell criterion={criterion} />
            <p className="note" style={{ margin: '0.8rem 0' }}>
              {describeNetworkCoverage(raw)}
            </p>
            {criterion.outcome.status === 'value' ? (
              <>
                <NetworkMembersTable members={raw.members} programId={programId} />
                <NetworkStateOwnershipTable entries={raw.stateOwnership} programId={programId} />
                <NetworkShownDetails shown={raw.shown} programId={programId} />
                {raw.members.length === 0 && raw.stateOwnership.length === 0 ? (
                  <p className="note" style={{ margin: '0.6rem 0 0' }}>
                    Nobody in the network carried a deduction — both automatic reads answered, and
                    finding nothing is itself the result, not a gap.
                  </p>
                ) : null}
              </>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}

/**
 * Every entity that deducted (network spec §5): its own worst level,
 * hop-discounted once at the shortest qualifying hop, cited to itself rather
 * than to the Supplier — the rule the former Corporate-family table stated,
 * now true of the whole Network rather than only its downward half.
 */
function NetworkMembersTable({
  members,
  programId,
}: {
  members: NetworkMemberRaw[];
  programId: string;
}) {
  if (members.length === 0) return null;
  return (
    <table style={{ marginTop: '0.6rem' }}>
      <thead>
        <tr>
          <th>Entity</th>
          <th className="num">Hop</th>
          <th>Level</th>
          <th className="num">Hop discount</th>
          <th className="num">Points</th>
          <th>Reached via</th>
          <th>Factors</th>
        </tr>
      </thead>
      <tbody>
        {members.map((member) => (
          <tr key={member.entityId}>
            <td>
              <Link href={`/program/${programId}/entity/${member.entityId}` as never}>
                {member.label}
              </Link>
            </td>
            <td className="num">{member.hopDepth}</td>
            <td>
              <span className={`badge ${member.level === 'high' ? 'bad' : 'warn'}`}>
                {member.level}
              </span>
            </td>
            <td className="num">{member.hopDiscount.toFixed(2)}</td>
            <td className="num">-{member.points.toFixed(1)}</td>
            <td className="note">{member.sources.join(', ')}</td>
            <td className="note">{member.factors.slice(0, 3).join(', ')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** State ownership stays its own deduction at hop 1 (`networkExposure`'s own doc comment) — shown apart from the table above so the two deductions are never read as one. */
function NetworkStateOwnershipTable({
  entries,
  programId,
}: {
  entries: NetworkStateOwnershipRaw[];
  programId: string;
}) {
  if (entries.length === 0) return null;
  return (
    <>
      <p className="note" style={{ margin: '0.8rem 0 0.3rem' }}>
        State-owned at hop 1, deducted separately from the table above:
      </p>
      <table>
        <tbody>
          {entries.map((owner) => (
            <tr key={owner.entityId}>
              <td>
                <Link href={`/program/${programId}/entity/${owner.entityId}` as never}>
                  {owner.label}
                </Link>
              </td>
              <td className="note">hop {owner.hopDepth}</td>
              <td className="num">-{owner.points.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/** Named but never deducted — reached only by a trade/lateral hop, or a Path with no hydrated edges yet (`networkExposure`'s own doc comment). Collapsed: this is the "shown, not scored" half nobody needs open by default. */
function NetworkShownDetails({
  shown,
  programId,
}: {
  shown: NetworkShownRaw[];
  programId: string;
}) {
  if (shown.length === 0) return null;
  return (
    <details style={{ marginTop: '0.8rem' }}>
      <summary>
        {shown.length} more named but not deducted — reached only by a trade or lateral hop, or a
        chain not yet hydrated
      </summary>
      <table style={{ marginTop: '0.4rem' }}>
        <tbody>
          {shown.map((entity) => (
            <tr key={entity.entityId}>
              <td>
                <Link href={`/program/${programId}/entity/${entity.entityId}` as never}>
                  {entity.label}
                </Link>
              </td>
              <td className="note">hop {entity.hopDepth}</td>
              <td>{entity.level ? <span className="badge mute">{entity.level}</span> : null}</td>
              <td className="note">{entity.sources.join(', ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
/**
 * The citable chain beneath the Network section above (network spec §6, §8):
 * every Path of kind `family` this Supplier holds, each edge with its type,
 * shares, date and a link to the record asserting it.
 *
 * **This is the fallback without scripts** — the diagram (ticket 05) is a
 * client-rendered `cytoscape` component fed the same stored Paths as JSON;
 * this section is plain server-rendered rows, collapsed beneath where that
 * diagram will sit, and it is what stays true with JavaScript off. It is also
 * what a citation resolves through: a Family member is cited to the record
 * asserting its own edge (ticket 02 "Done when"), and this table is that
 * record made legible rather than only machine-resolvable.
 *
 * **Still `family`-only, not widened to `watchlist` too (unit 03e's own
 * decision).** `data` (`loadSupplierPage`) only ever loaded `kind='family'`
 * Paths — `loadFamilyPaths`, never `loadNetworkExposurePaths` — and widening
 * that read is a change to `src/db/queries/supplier-page.ts`, a file this
 * unit does not own (two other units were building `src/db/*` at the same
 * time). The Network section above already names every watchlist-reached
 * entity at the level `networkExposure`'s `rawInputs` carries (`members`/
 * `shown`, tagged by `sources`); what is missing here is only the edge-level
 * chain for those Paths, which whichever unit next touches this query should
 * add — either by widening this table's own `familyChain` prop to accept
 * both kinds, or a second `<details>` block beside it. Either reads fine; the
 * absent piece is the query, not a rendering choice.
 */
export function FamilyChainRows({ data, programId }: { data: Data; programId: string }) {
  const { familyChain } = data;
  if (familyChain.length === 0) return null;

  return (
    <details className="card scroll-x" style={{ marginTop: '0.6rem' }}>
      <summary>Chain rows — every cited edge the downward family walk holds</summary>
      <table>
        <thead>
          <tr>
            <th>Member</th>
            <th>Edge type</th>
            <th className="num">Share</th>
            <th>From</th>
            <th>To</th>
            <th>Record</th>
          </tr>
        </thead>
        <tbody>
          {familyChain.map((path) =>
            path.edges.length === 0 ? (
              <tr key={path.terminalEntityId}>
                <td>
                  <Link href={`/program/${programId}/entity/${path.terminalEntityId}` as never}>
                    {path.label}
                  </Link>
                </td>
                {/* A migrated `family_member` row (migration 0013) or one whose
                    edge upsert has not landed yet — a stated gap, not a guess. */}
                <td className="note" colSpan={5}>
                  no citable edge yet
                </td>
              </tr>
            ) : (
              path.edges.map((edge, i) => (
                <tr key={edge.id}>
                  <td>
                    {i === 0 ? (
                      <Link href={`/program/${programId}/entity/${path.terminalEntityId}` as never}>
                        {path.label}
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
              ))
            ),
          )}
        </tbody>
      </table>
    </details>
  );
}

/** The record route takes a catch-all segment, because a record id is itself a `/`-joined path (`record-page.ts`'s own comment). */
function recordHref(programId: string, recordId: string): string {
  return `/program/${programId}/record/${recordId.split('/').map(encodeURIComponent).join('/')}`;
}

export function Enrichments({ data }: { data: Data }) {
  const { enrichments } = data;
  return (
    <>
      {/* ── Enrichments ── */}
      <h3>
        <span className="term">
          What we fetched, and when<i>Enrichments</i>
        </span>
      </h3>
      <div className="card scroll-x">
        {enrichments.length === 0 ? (
          <p className="empty">Nothing fetched yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>Subject</th>
                <th>Fetched</th>
                <th>Age</th>
              </tr>
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
    </>
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

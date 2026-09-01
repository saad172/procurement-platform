import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getPooledDb } from '@/db/client';
import { loadProgramPage } from '@/db/queries/program-page';
import { Breadcrumb } from '@/components/breadcrumb';
import { ChatDock } from '@/components/chat-dock';
import { LiveRefresh } from '@/components/live-refresh';
import { CountryBreakdown, MatchOutcomes, SharedOwnership, SupplierMap } from './charts';
import { RunPanel } from './run-panel';
import { SupplierTable } from './supplier-table';

/**
 * The Program page (SPEC §13.2) — the top of the spine.
 *
 *     Program → Category → Supplier → Sayari entity → record
 *
 * Four charts, all of which survive, each answering a question the Category
 * table cannot. **The charts are the filter control**: clicking Germany on the
 * country bars narrows the table below, and there is no separate filter UI.
 */
export const dynamic = 'force-dynamic';

export default async function ProgramPage({
  params,
  searchParams,
}: {
  params: Promise<{ programId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { programId } = await params;
  const query = await searchParams;
  const db = getPooledDb();

  const data = await loadProgramPage(db, { programId, query });
  if (!data) notFound();

  const {
    program,
    view,
    search,
    suppliers,
    matches,
    matchBySupplier,
    work,
    workerUp,
    running,
    assessedIds,
    waitingOnYou,
    uncategorised,
    bandBySupplier,
    supplierPoints,
    biddersByCategory,
    recByCategory,
    attemptByCategory,
    runs,
    spent,
    awardable,
    answers,
  } = data;

  return (
    <main>
      <Breadcrumb trail={[{ label: program.name }]} />
      <h1>{program.name}</h1>
      <p className="sub">
        {program.vehicleClass} · importing into {program.importingCountry} · {program.sourcingHorizon}
      </p>

      {/* ── The answers, before any of the apparatus ── */}
      {answers.map((answer) => (
        <div
          key={answer.said}
          className={`answer ${answer.tone === 'neutral' ? '' : answer.tone}`}
        >
          <p className="said">
            {answer.said}
            {running && answer.said.endsWith('is running.') ? (
              <>
                {' '}
                <LiveRefresh active />
              </>
            ) : null}
          </p>
          <p className="because">{answer.because}</p>
          {answer.actions.length > 0 ? (
            <div className="do">
              {answer.actions.map((action) => (
                <Link
                  key={action.label}
                  className={`btn ${action.primary ? 'primary' : ''}`}
                  href={action.href as never}
                >
                  {action.label}
                </Link>
              ))}
            </div>
          ) : null}
        </div>
      ))}

      {/* ── Where you stand ── */}
      <h2>Where you stand</h2>
      <div className="where">
        <div className={awardable === 0 ? 'bad' : ''}>
          <b>
            {awardable} of {program.categories.length}
          </b>
          <span>categories with an argued case behind them</span>
        </div>
        <div className={assessedIds.size < suppliers.length / 2 ? 'warn' : ''}>
          <b>
            {assessedIds.size} of {suppliers.length}
          </b>
          <span>suppliers fully worked up</span>
        </div>
        <div className={waitingOnYou > 0 ? 'warn' : ''}>
          <b>{waitingOnYou}</b>
          <span>waiting on your decision</span>
        </div>
        <div>
          <b>
            {matches.filter((m) => m.status === 'accepted').length} of {suppliers.length}
          </b>
          <span>suppliers we could identify</span>
        </div>
        <div>
          <b>{uncategorised.length}</b>
          <span>not mapped to any category, so cannot be ranked</span>
        </div>
        <div>
          <b>${spent.toFixed(2)}</b>
          <span>
            {/*
              Real spend, summed from usage. The strip here used to show the
              LAST RUN's estimate, which is a ceiling somebody agreed to rather
              than money that went — and labelled "last run", so it read as
              both and was neither.
            */}
            spent so far, across {runs.length} {runs.length === 1 ? 'run' : 'runs'}
          </span>
        </div>
      </div>
      <p className="note" style={{ margin: '-0.9rem 0 1.6rem', maxWidth: '56rem' }}>
        A category can be awarded once its bidders have been researched and{' '}
        <span className="term">
          an argued case written for it<i>Recommendation</i>
        </span>
        . <Link href={`/program/${programId}/runs` as never}>What has run, and what it cost</Link>.
      </p>

      {/* ── The working ── */}
      <h2>The working</h2>
      <p className="note" style={{ margin: '-0.4rem 0 0.8rem', maxWidth: '56rem' }}>
        What you can set going, and the shape of the roster underneath the figures above.
      </p>

      <RunPanel programId={programId} work={work} workerUp={workerUp} />

      {/*
        Four charts, and the charts ARE the filter control. Clicking a bar
        navigates — because view state lives in the URL, a filter is a link.
      */}
      <h3>Where this roster is, and whether resolution worked</h3>
      {/*
        The map opens the section at full content width; the other three keep
        the grid beneath it. It is the only chart here that is a picture of the
        world rather than of a column, and at a third of the width it was a
        thumbnail of one.
      */}
      <SupplierMap
        plants={program.plants}
        suppliers={supplierPoints}
        supplierTotal={suppliers.length}
        region={view.mapRegion}
        programId={programId}
        activeBands={view.facets.proximityBand ?? []}
      />
      <div className="grid two">
        <CountryBreakdown
          programId={programId}
          suppliers={suppliers}
          active={view.facets.country ?? []}
          search={search}
        />
        <MatchOutcomes
          programId={programId}
          suppliers={suppliers}
          matchBySupplier={matchBySupplier}
          active={view.facets.matchStatus ?? []}
          search={search}
        />
        <SharedOwnership matchBySupplier={matchBySupplier} suppliers={suppliers} />
      </div>

      <h3>What you are buying</h3>
      <div className="card scroll-x">
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Category</th>
              <th className="num">Bidders</th>
              <th>Recommendation</th>
              <th>Tariff code</th>
              <th className="num">Base duty</th>
            </tr>
          </thead>
          <tbody>
            {program.categories.map((category) => {
              const line = category.hsLines.find((l) => l.isDefault);
              /*
                `hsLines` holds every candidate classification, not just the
                scored one. The header used to read "Default HS line", and that
                word Default was the only thing saying a choice had been made —
                dropping the jargon dropped the signal with it, so the count
                says it in words. ENC has three candidates in a 0.4-point band;
                BAT has one and is settled. That difference is worth a glance.
              */
              const others = category.hsLines.length - 1;
              const rec = recByCategory.get(category.id);
              /*
                Only read when nothing was published — a Category with a
                version shows the version, whatever a later re-run did.
              */
              const attempt = recByCategory.has(category.id)
                ? undefined
                : attemptByCategory.get(category.id);
              const attemptSays =
                attempt?.outcome === 'in_flight'
                  ? { badge: 'being written', tone: '', link: 'follow the run' }
                  : attempt?.outcome === 'refused'
                    ? { badge: 'nothing published', tone: 'warn', link: 'why nothing was published' }
                    : attempt
                      ? { badge: 'the run broke', tone: 'bad', link: 'what broke' }
                      : null;
              return (
                <tr key={category.id}>
                  <td>
                    <Link href={`/program/${programId}/category/${category.id}` as never}>
                      <strong>{category.code}</strong>
                    </Link>
                  </td>
                  <td>{category.name}</td>
                  <td className="num">{biddersByCategory.get(category.id) ?? 0}</td>
                  <td>
                    {rec ? (
                      <>
                        <Link
                          href={
                            `/program/${programId}/category/${category.id}/recommendation` as never
                          }
                        >
                          Version {rec.n}
                        </Link>{' '}
                        <span
                          className={`badge ${rec.evaluatorOutcome === 'passed' ? 'good' : 'warn'}`}
                        >
                          {rec.evaluatorOutcome.replace(/_/g, ' ')}
                        </span>
                        {rec.awardedTo ? <div className="note">awards {rec.awardedTo}</div> : null}
                        {rec.humanMark ? (
                          <div className="note">
                            marked {rec.humanMark.replace(/_/g, ' ')} by a person
                          </div>
                        ) : null}
                      </>
                    ) : attemptSays && attempt ? (
                      <>
                        <span className={`badge ${attemptSays.tone}`}>{attemptSays.badge}</span>
                        <div className="note">
                          <Link href={attempt.href as never}>{attemptSays.link}</Link>
                        </div>
                      </>
                    ) : (
                      <span className="note">none written</span>
                    )}
                  </td>
                  <td>
                    {line ? (
                      <>
                        <div className="mono">{line.hsCode}</div>
                        <div className="note">{line.label}</div>
                        {others > 0 ? (
                          <div className="note">
                            + {others} {others === 1 ? 'other' : 'others'} considered
                          </div>
                        ) : null}
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="num">{line ? `${Number(line.rate)}%` : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/*
        The detail page states the invariant — the caveat rides with every rate
        — and then honours it. This table did not, and "Base duty" claims more
        than "MFN" did, because MFN at least announced itself as one specific
        legal rate. One note under the card, carrying the framing and the
        caveat together: two grey paragraphs around an eight-row table is more
        apparatus than the table.
      */}
      <p className="note" style={{ margin: '0.6rem 0 1.6rem', maxWidth: '56rem' }}>
        Base duty is the ordinary rate for that code into {program.importingCountry}. It is a floor,
        not a landed cost — surcharges that key on where a part is actually made are not folded in.
        Open a category for the full picture.
      </p>

      <h3>
        Every company on the roster{' '}
        <span className="note">
          {uncategorised.length} of {suppliers.length} are not mapped to any category, and reach no shortlist
        </span>
      </h3>
      <SupplierTable
        programId={programId}
        suppliers={suppliers}
        matchBySupplier={matchBySupplier}
        assessedIds={assessedIds}
        facets={view.facets}
        bandBySupplier={bandBySupplier}
      />
      <ChatDock programId={programId} />
    </main>
  );
}

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { and, eq, isNull } from 'drizzle-orm';
import { getPooledDb } from '@/db/client';
import * as t from '@/db/schema';
import { Breadcrumb } from '@/components/breadcrumb';
import { ChatDock } from '@/components/chat-dock';
import { parseViewState } from '@/lib/view-state';
import { activeRun, rosterWork, workerSeemsUp } from '@/db/queries/runs';
import { LiveRefresh } from '@/components/live-refresh';
import { CountryBreakdown, MatchOutcomes, SharedOwnership, SupplierMap } from './charts';
import { RunPanel } from './run-panel';
import { programmeAnswer } from '@/domain/programme-answer';
import { loadRuns } from '@/db/queries/runs';
import { SupplierTable } from './supplier-table';

/**
 * The Programme page (SPEC §13.2) — the top of the spine.
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

  const program = await db.query.program.findFirst({
    where: eq(t.program.id, programId),
    with: { plants: true, categories: { with: { hsLines: true } }, weights: true },
  });
  if (!program) notFound();

  const programDefault = Object.fromEntries(program.weights.map((w) => [w.criterionKey, Number(w.weight)]));
  const view = parseViewState(query, programDefault);

  const suppliers = await db.select().from(t.supplier).where(eq(t.supplier.programId, programId));
  const matches = await db
    .select({ supplierId: t.match.supplierId, status: t.match.status, entityId: t.match.entityId, settledBy: t.match.settledBy })
    .from(t.match)
    .innerJoin(t.supplier, eq(t.supplier.id, t.match.supplierId))
    .where(eq(t.supplier.programId, programId));
  const matchBySupplier = new Map(matches.map((m) => [m.supplierId, m]));

  /**
   * What a Run would actually do, and whether anything is listening.
   *
   * The worker check is a **liveness** question, not a health one: a Job queued
   * with no worker running sits in `queued` for ever and the page would
   * otherwise look like it had done something. Recent activity is the only
   * signal available from here — the worker holds no inbound port by design.
   */
  const work = await rosterWork(db, programId);
  const workerUp = await workerSeemsUp(db);
  /**
   * A Run still moving, if there is one. Without it this page is unchanged by
   * the click that started it — the unresolved count only falls when a Match
   * lands — so coming back here mid-run would look like nothing had happened.
   */
  const running = await activeRun(db, programId);

  const assessed = await db
    .select({ supplierId: t.assessment.supplierId })
    .from(t.assessment)
    .where(and(eq(t.assessment.programId, programId), eq(t.assessment.kind, 'standard')));
  const assessedIds = new Set(assessed.map((a) => a.supplierId));

  const waitingOnYou = matches.filter((m) => m.status === 'needs_review').length;

  const uncategorised = await db
    .select({ id: t.supplier.id })
    .from(t.supplier)
    .leftJoin(t.supplierCategory, eq(t.supplierCategory.supplierId, t.supplier.id))
    .where(and(eq(t.supplier.programId, programId), isNull(t.supplierCategory.categoryId)));

  const bidderCounts = await db
    .select({ categoryId: t.supplierCategory.categoryId })
    .from(t.supplierCategory)
    .innerJoin(t.supplier, eq(t.supplier.id, t.supplierCategory.supplierId))
    .where(eq(t.supplier.programId, programId));
  const biddersByCategory = new Map<string, number>();
  for (const row of bidderCounts) {
    biddersByCategory.set(row.categoryId, (biddersByCategory.get(row.categoryId) ?? 0) + 1);
  }

  const recommendations = await db
    .select({ categoryId: t.recommendation.categoryId })
    .from(t.recommendation)
    .where(eq(t.recommendation.programId, programId));

  /**
   * The rows only a person can settle, **named**. A count alone makes them
   * anonymous, and two roster names are what turns "2 waiting" into a task.
   */
  const waitingNames = suppliers
    .filter((row) => matchBySupplier.get(row.id)?.status === 'needs_review')
    .map((row) => row.rosterName ?? 'a promoted lead');

  // Real spend, summed from usage rather than from a Run's estimate: an
  // estimate is a ceiling somebody agreed to, not money that went.
  const runs = await loadRuns(db, programId);
  const spent = runs.reduce((sum, run) => sum + run.actualUsd, 0);

  const awardable = new Set(recommendations.map((r) => r.categoryId)).size;

  const answers = programmeAnswer({
    workerUp,
    running: running
      ? {
          jobsInFlight: running.running,
          queued: running.queued,
          href: `/program/${programId}/runs/${running.id}`,
          label: running.subjectLabel ?? 'A run',
        }
      : undefined,
    suppliers: {
      total: suppliers.length,
      identified: matches.filter((m) => m.status === 'accepted').length,
      assessed: assessedIds.size,
      uncategorised: uncategorised.length,
    },
    waitingOnYou: { count: waitingOnYou, names: waitingNames },
    categories: {
      total: program.categories.length,
      withRecommendation: awardable,
    },
    needsReviewHref: `/program/${programId}/needs-review`,
    runsHref: `/program/${programId}/runs`,
  });

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
          <span>categories you could award today</span>
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
          <span>bid on no category, so cannot be ranked</span>
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
      <div className="grid two">
        <CountryBreakdown
          programId={programId}
          suppliers={suppliers}
          active={view.facets.country ?? []}
        />
        <MatchOutcomes
          programId={programId}
          suppliers={suppliers}
          matchBySupplier={matchBySupplier}
          active={view.facets.matchStatus ?? []}
        />
        <SupplierMap plants={program.plants} region={view.mapRegion} programId={programId} />
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
              <th>Default HS line</th>
              <th className="num">MFN</th>
            </tr>
          </thead>
          <tbody>
            {program.categories.map((category) => {
              const line = category.hsLines.find((l) => l.isDefault);
              return (
                <tr key={category.id}>
                  <td>
                    <Link href={`/program/${programId}/category/${category.id}` as never}>
                      <strong>{category.code}</strong>
                    </Link>
                  </td>
                  <td>{category.name}</td>
                  <td className="num">{biddersByCategory.get(category.id) ?? 0}</td>
                  <td className="mono">{line?.hsCode ?? '—'}</td>
                  <td className="num">{line ? `${Number(line.rate)}%` : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h3>
        Every company on the roster{' '}
        <span className="note">
          {uncategorised.length} of {suppliers.length} bid on no category, and reach no shortlist
        </span>
      </h3>
      <SupplierTable
        programId={programId}
        suppliers={suppliers}
        matchBySupplier={matchBySupplier}
        assessedIds={assessedIds}
        facets={view.facets}
      />
      <ChatDock programId={programId} />
    </main>
  );
}

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { getPooledDb } from '@/db/client';
import * as t from '@/db/schema';
import { Breadcrumb } from '@/components/breadcrumb';
import { ChatDock } from '@/components/chat-dock';
import { parseViewState } from '@/lib/view-state';
import { activeRun, rosterWork, workerSeemsUp } from '@/db/queries/runs';
import { LiveRefresh } from '@/components/live-refresh';
import { CountryBreakdown, MatchOutcomes, SharedOwnership, SupplierMap } from './charts';
import { RunPanel } from './run-panel';
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
  const lastRun = await db.query.run.findFirst({
    where: eq(t.run.programId, programId),
    orderBy: [desc(t.run.createdAt)],
  });

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

  return (
    <main>
      <Breadcrumb trail={[{ label: program.name }]} />
      <h1>{program.name}</h1>
      <p className="sub">
        {program.vehicleClass} · importing into {program.importingCountry} · {program.sourcingHorizon}
      </p>

      {/*
        The Programme strip carries EXACTLY TWO FIGURES (SPEC §13.2):
        completeness, linking to Needs Review, and cost, linking to Runs.
        Completeness deliberately does not live on the Runs page — "is my work
        done?" and "what did it cost?" are different questions, and only the
        first belongs where a person starts.
      */}
      <section className="card strip" aria-label="Programme status">
        <div>
          <span className="figure">
            {assessedIds.size} of {suppliers.length} assessed
          </span>
          <span className="label">
            {waitingOnYou > 0 ? (
              <Link href={`/program/${programId}/needs-review` as never}>{waitingOnYou} waiting on you</Link>
            ) : (
              'nothing waiting on you'
            )}
          </span>
        </div>
        <div>
          <span className="figure">
            {lastRun?.estimateUsd ? `$${Number(lastRun.estimateUsd).toFixed(2)}` : '—'}
          </span>
          <span className="label">
            <Link href={`/program/${programId}/runs` as never}>last run</Link>
          </span>
        </div>
      </section>

      {running ? (
        <section className="card" aria-label="Run in progress">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
            <strong>
              <Link href={`/program/${programId}/runs/${running.id}` as never}>
                {running.subjectLabel ?? 'A run'}
              </Link>{' '}
              is running
            </strong>
            <LiveRefresh active />
          </div>
          <p className="note" style={{ margin: '0.4rem 0 0' }}>
            {running.running} job{running.running === 1 ? '' : 's'} in flight, {running.queued}{' '}
            queued. The figures below update as matches land; the job-by-job view is on the{' '}
            <Link href={`/program/${programId}/runs/${running.id}` as never}>run page</Link>.
          </p>
        </section>
      ) : null}

      <RunPanel programId={programId} work={work} workerUp={workerUp} />

      {/*
        Four charts, and the charts ARE the filter control. Clicking a bar
        navigates — because view state lives in the URL, a filter is a link.
      */}
      <h2>Where this roster is, and whether resolution worked</h2>
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

      <h2>Categories</h2>
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

      <h2>
        Suppliers{' '}
        <span className="note">
          {uncategorised.length} of {suppliers.length} bid on no category, and reach no shortlist
        </span>
      </h2>
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

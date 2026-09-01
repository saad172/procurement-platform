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
import { programmeAnswer } from '@/domain/programme-answer';
import { loadRuns } from '@/db/queries/runs';
import { nearestPlant, proximityBand } from '@/domain/geo';
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
  /**
   * The page's own query string, threaded into every chart that builds a link.
   * Without it a chart click discards the weight rail's what-if and the map's
   * camera — see `facetHref`.
   */
  const search = new URLSearchParams(
    Object.entries(query).flatMap(([key, value]) =>
      value == null ? [] : Array.isArray(value) ? value.map((v) => [key, v] as [string, string]) : [[key, value] as [string, string]],
    ),
  ).toString();

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

  /**
   * Where each Supplier sits, for the Plant map.
   *
   * The fallback order mirrors `enrich-supplier` exactly — Sayari's own
   * coordinate on the resolved Profile, then the Nominatim `geocode` row keyed
   * on the Supplier — because a dot the map draws somewhere the proximity
   * Criterion measured from somewhere else is two answers to one question.
   *
   * A Supplier with neither is **left out rather than placed at a default**,
   * and the map says how many that is. Proximity scores it `unknown`, which
   * drops out of the Score; a stand-in coordinate would score it instead.
   */
  const profilePoints = await db
    .select({ supplierId: t.match.supplierId, lat: t.entity.lat, lon: t.entity.lon })
    .from(t.match)
    .innerJoin(t.supplier, eq(t.supplier.id, t.match.supplierId))
    .innerJoin(t.entity, eq(t.entity.id, t.match.entityId))
    .where(and(eq(t.supplier.programId, programId), eq(t.match.status, 'accepted')));

  const geocodePoints = await db
    .select({ supplierKey: t.enrichment.subjectKey, lat: t.geocode.lat, lon: t.geocode.lon })
    .from(t.geocode)
    .innerJoin(t.enrichment, eq(t.enrichment.id, t.geocode.enrichmentId))
    .where(eq(t.enrichment.subjectKind, 'address'));

  const pointBySupplier = new Map<string, { lat: number; lon: number }>();
  for (const row of geocodePoints) {
    if (row.lat == null || row.lon == null) continue;
    pointBySupplier.set(row.supplierKey, { lat: row.lat, lon: row.lon });
  }
  for (const row of profilePoints) {
    if (row.lat == null || row.lon == null) continue;
    pointBySupplier.set(row.supplierId, { lat: row.lat, lon: row.lon });
  }

  const plantPoints = program.plants.map((p) => ({ code: p.code, city: p.city, lat: p.lat, lon: p.lon }));
  /**
   * A Supplier's band, for the roster filter. Computed here rather than in the
   * map so the table and the dots can never disagree about which band a
   * company is in — one `nearestPlant` call, two readers.
   */
  const bandBySupplier = new Map<string, string>();

  const supplierPoints = suppliers.flatMap((supplier) => {
    const point = pointBySupplier.get(supplier.id);
    if (!point) return [];
    const nearest = nearestPlant(point, plantPoints);
    if (nearest) bandBySupplier.set(supplier.id, proximityBand(nearest.km));
    return [
      {
        id: supplier.id,
        name: supplier.rosterName ?? 'a promoted lead',
        country: supplier.rosterCountry ?? 'unknown',
        status: matchBySupplier.get(supplier.id)?.status ?? 'not yet run',
        assessed: assessedIds.has(supplier.id),
        ...point,
      },
    ];
  });

  const bidderCounts = await db
    .select({ categoryId: t.supplierCategory.categoryId })
    .from(t.supplierCategory)
    .innerJoin(t.supplier, eq(t.supplier.id, t.supplierCategory.supplierId))
    .where(eq(t.supplier.programId, programId));
  const biddersByCategory = new Map<string, number>();
  for (const row of bidderCounts) {
    biddersByCategory.set(row.categoryId, (biddersByCategory.get(row.categoryId) ?? 0) + 1);
  }

  /**
   * What each Category's argued case actually says, not merely whether a row
   * exists. The Category table below is where a person picks which Category to
   * open next, and the state of its Recommendation is the most useful thing
   * that table can tell them — so it carries the award Pick and the
   * evaluator's outcome, at the weight the Category page states them.
   *
   * Latest version by `n`, matching the Category and Recommendation pages. A
   * header with no version is not an argued case, and counts as none.
   */
  const recommendations = await db.query.recommendation.findMany({
    where: eq(t.recommendation.programId, programId),
    with: {
      versions: {
        orderBy: [desc(t.recommendationVersion.n)],
        limit: 1,
        with: { picks: { with: { supplier: true } } },
      },
    },
  });
  const recByCategory = new Map(
    recommendations.flatMap((rec) => {
      const version = rec.versions[0];
      if (!version) return [];
      const award = version.picks.find((pick) => pick.role === 'award');
      return [
        [
          rec.categoryId,
          {
            n: version.n,
            evaluatorOutcome: version.evaluatorOutcome,
            humanMark: version.humanMark,
            awardedTo: award?.supplier.rosterName ?? null,
          },
        ] as const,
      ];
    }),
  );

  /**
   * A Recommend that ran and published nothing is **not** the same thing as one
   * nobody asked for, and with only the table above both rows read blank.
   *
   * That distinction is the point of `terminated`: the loop refused its own
   * draft in every round, which is a result about the evidence rather than an
   * absence of one — and the Job page says which rubric item it died on. Last
   * attempt wins; it is only ever read for a Category with no published
   * version, so a `done` Job needs no special case.
   */
  const recommendJobs = await db
    .select({
      subjectId: t.job.subjectId,
      state: t.job.state,
      jobId: t.job.id,
      runId: t.job.runId,
    })
    .from(t.job)
    .innerJoin(t.run, eq(t.run.id, t.job.runId))
    .where(
      and(
        eq(t.run.programId, programId),
        eq(t.job.kind, 'recommend'),
        eq(t.job.subjectType, 'category'),
      ),
    )
    .orderBy(t.job.createdAt);

  const attemptByCategory = new Map<
    string,
    { outcome: 'in_flight' | 'refused' | 'broke'; href: string }
  >();
  for (const job of recommendJobs) {
    const href = `/program/${programId}/runs/${job.runId}/job/${job.jobId}`;
    if (job.state === 'queued' || job.state === 'running' || job.state === 'paused_on_budget') {
      attemptByCategory.set(job.subjectId, { outcome: 'in_flight', href });
    } else if (job.state === 'terminated') {
      attemptByCategory.set(job.subjectId, { outcome: 'refused', href });
    } else if (job.state === 'failed') {
      attemptByCategory.set(job.subjectId, { outcome: 'broke', href });
    }
  }

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

  const awardable = recByCategory.size;

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

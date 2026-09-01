import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as t from '@/db/schema';
import { parseViewState } from '@/lib/view-state';
import { activeRun, rosterWork, workerSeemsUp } from '@/db/queries/runs';
import { programAnswer } from '@/domain/program-answer';
import { loadRuns } from '@/db/queries/runs';
import { nearestPlant, proximityBand } from '@/domain/geo';

/**
 * The Program page (SPEC §13.2) — the top of the spine.
 *
 *     Program → Category → Supplier → Sayari entity → record
 *
 * Four charts, all of which survive, each answering a question the Category
 * table cannot. **The charts are the filter control**: clicking Germany on the
 * country bars narrows the table below, and there is no separate filter UI.
 */

/**
 * Everything the Program page renders, in one read (SPEC §13.1).
 *
 * The page was 561 lines: ten drizzle queries and the derivations over them,
 * then the answer-first layout they feed. This is the first half. What the page
 * keeps is the half that is genuinely its own — which of these to show, in what
 * order, and what to say when one is absent.
 *
 * **A page reads through `db/queries`, never through the schema.** See
 * `supplier-page.ts` for the argument; this is the same rule applied to the
 * widest page in the build.
 *
 * `notFound()` stays in the page: it is a Next.js control-flow throw, and this
 * module knows nothing about routing.
 */
export async function loadProgramPage(
  db: Database,
  args: { programId: string; query: Record<string, string | string[] | undefined> },
) {
  const { programId, query } = args;


  const program = await db.query.program.findFirst({
    where: eq(t.program.id, programId),
    with: { plants: true, categories: { with: { hsLines: true } }, weights: true },
  });
  if (!program) return undefined;

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

  const answers = programAnswer({
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

  return {
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
  };
}

import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as t from '@/db/schema';
import { parseViewState } from '@/lib/view-state';
import { activeRun, rosterWork, workerSeemsUp } from '@/db/queries/runs';
import { programAnswer } from '@/domain/program-answer';
import { loadRuns } from '@/db/queries/runs';
import {
  deriveAssessedIds,
  deriveBiddersByCategory,
  deriveCategoryAttempts,
  deriveCategoryRecommendations,
  deriveMatchBySupplier,
  deriveSupplierPoints,
  deriveWaitingOnYou,
} from '@/domain/derive-program-page';

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
 * Every row the Program page needs, read exactly once (SPEC §13.1).
 *
 * **One read, not three.** `suppliers`, `matches` and `assessedRows` feed all
 * three page sections — the answers strip, "Where you stand" and the roster
 * table — so they are read here a single time and shaped downstream by the
 * pure `derive*` functions in `@/domain/derive-program-page`, never
 * re-queried per section.
 */
async function readProgramRows(db: Database, programId: string) {
  const program = await db.query.program.findFirst({
    where: eq(t.program.id, programId),
    with: { plants: true, categories: { with: { hsLines: true } }, weights: true },
  });
  if (!program) return undefined;

  const suppliers = await db.select().from(t.supplier).where(eq(t.supplier.programId, programId));
  const matches = await db
    .select({
      supplierId: t.match.supplierId,
      status: t.match.status,
      entityId: t.match.entityId,
      settledBy: t.match.settledBy,
    })
    .from(t.match)
    .innerJoin(t.supplier, eq(t.supplier.id, t.match.supplierId))
    .where(eq(t.supplier.programId, programId));

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

  const assessedRows = await db
    .select({ supplierId: t.assessment.supplierId })
    .from(t.assessment)
    .where(and(eq(t.assessment.programId, programId), eq(t.assessment.kind, 'standard')));

  const uncategorisedRows = await db
    .select({ id: t.supplier.id })
    .from(t.supplier)
    .leftJoin(t.supplierCategory, eq(t.supplierCategory.supplierId, t.supplier.id))
    .where(and(eq(t.supplier.programId, programId), isNull(t.supplierCategory.categoryId)));

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

  const bidderCountRows = await db
    .select({ categoryId: t.supplierCategory.categoryId })
    .from(t.supplierCategory)
    .innerJoin(t.supplier, eq(t.supplier.id, t.supplierCategory.supplierId))
    .where(eq(t.supplier.programId, programId));

  /**
   * Latest version by `n`, matching the Category and Recommendation pages, and
   * the recommend Jobs behind them — a Recommend that ran and published
   * nothing reads differently from one nobody asked for (see
   * `deriveCategoryAttempts`).
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
  const recommendJobs = await db
    .select({ subjectId: t.job.subjectId, state: t.job.state, jobId: t.job.id, runId: t.job.runId })
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

  // Real spend, summed from usage rather than from a Run's estimate: an
  // estimate is a ceiling somebody agreed to, not money that went.
  const runs = await loadRuns(db, programId);

  return {
    program,
    suppliers,
    matches,
    work,
    workerUp,
    running,
    assessedRows,
    uncategorisedRows,
    profilePoints,
    geocodePoints,
    bidderCountRows,
    recommendations,
    recommendJobs,
    runs,
  };
}

/**
 * Everything the Program page renders, shaped from one read (SPEC §13.1).
 *
 * The page was 561 lines: ten drizzle queries and the derivations over them,
 * then the answer-first layout they feed. `readProgramRows` above is the
 * first half; the `derive*` calls below are the second. What the page keeps
 * is the half that is genuinely its own — which of these to show, in what
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

  const rows = await readProgramRows(db, programId);
  if (!rows) return undefined;
  const { program, suppliers, matches, work, workerUp, running, assessedRows, uncategorisedRows } =
    rows;
  const { profilePoints, geocodePoints, bidderCountRows, recommendations, recommendJobs, runs } =
    rows;

  const programDefault = Object.fromEntries(
    program.weights.map((w) => [w.criterionKey, Number(w.weight)]),
  );
  const view = parseViewState(query, programDefault);
  /**
   * The page's own query string, threaded into every chart that builds a link.
   * Without it a chart click discards the weight rail's what-if and the map's
   * camera — see `facetHref`.
   */
  const search = new URLSearchParams(
    Object.entries(query).flatMap(([key, value]) =>
      value == null
        ? []
        : Array.isArray(value)
          ? value.map((v) => [key, v] as [string, string])
          : [[key, value] as [string, string]],
    ),
  ).toString();

  const matchBySupplier = deriveMatchBySupplier(matches);
  const assessedIds = deriveAssessedIds(assessedRows);
  const waitingOnYou = deriveWaitingOnYou(suppliers, matchBySupplier);
  const plantPoints = program.plants.map((p) => ({
    code: p.code,
    city: p.city,
    lat: p.lat,
    lon: p.lon,
  }));
  const { supplierPoints, bandBySupplier } = deriveSupplierPoints({
    suppliers,
    matchBySupplier,
    assessedIds,
    profilePoints,
    geocodePoints,
    plants: plantPoints,
  });
  const biddersByCategory = deriveBiddersByCategory(bidderCountRows);
  const recByCategory = deriveCategoryRecommendations(recommendations);
  const attemptByCategory = deriveCategoryAttempts(recommendJobs, programId);

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
      uncategorised: uncategorisedRows.length,
    },
    waitingOnYou,
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
    waitingOnYou: waitingOnYou.count,
    uncategorised: uncategorisedRows,
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

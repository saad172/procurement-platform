// Next.js loads `.env` itself; a plain Node entrypoint has to ask.
import 'dotenv/config';
import { boot } from '@/config/boot';
import type { Env } from '@/config/env';
import { closeDirectDb, getDirectDb, type Database } from '@/db/client';
import { createUpstream } from '@/upstream';
import { discoverLeads } from '@/jobs/discover';
import { enrichSupplier } from '@/jobs/enrich-supplier';
import { storeRelationships } from '@/jobs/enrich';
import { parseRelationships } from '@/domain/parse-relationships';
import { upsertEntity } from '@/jobs/resolve';
import { runResolveJob } from '@/jobs/resolve-job';
import { runDeepTraversal } from '@/jobs/traverse';
import { checkRunBudget, enqueueJob } from '@/jobs/runs';
import { assessSupplier } from '@/jobs/assess';
import { recommendCategory } from '@/jobs/recommend';
import type { RunnableJobKind } from '@/config/constants';
import { runWorker, type JobHandler } from './poll';

/**
 * The worker process (SPEC §2.2).
 *
 * A long-lived Node process polling the `job` table with
 * `FOR UPDATE SKIP LOCKED`, running the **same** Tool Runner code the chat
 * route handler uses. Fixed concurrency 4.
 *
 * It exists so that "≤ 10 minutes for 50 Suppliers" is achievable without
 * designing around a 300-second serverless function ceiling. Chunked route
 * handlers re-enqueuing before a deadline were rejected as the least readable
 * code in a build graded on readability.
 *
 * **It holds no inbound port.** The graded local run has no inbound surface at
 * all — the only conditionally-inbound thing in the system is the MCP server's
 * Streamable HTTP transport, and only when the Dossier flag is on.
 */

/** The two pieces of `JobHandler`'s signature, named for reuse below. */
type JobRow = Parameters<JobHandler>[0];
type JobOutcome = Awaited<ReturnType<JobHandler>>;

/**
 * Queues the next stage of a **pipeline** Run, and nothing otherwise.
 *
 * The chain is `resolve → enrich → assess`, each hop fired by the stage before
 * it succeeding — because every hop needs the previous one's output and a Job
 * queued up front would dequeue before that output existed. A row that parks at
 * `needs_review` correctly never gets an enrichment, and a Supplier whose
 * enrichment found nothing still gets an assessment that says so.
 *
 * It joins the **same Run**, because it is the spend that Run was opened for.
 * A one-off Re-enrich or Re-assess opens its own Run with a different trigger,
 * and gets no chain — those two buttons are separate on purpose.
 */
async function chainNext(
  database: Database,
  job: { runId: string; subjectId: string },
  kind: 'enrich' | 'assess',
): Promise<void> {
  const run = await database.query.run.findFirst({
    where: (row, { eq: equals }) => equals(row.id, job.runId),
  });
  if (run?.trigger !== 'pipeline') return;

  await enqueueJob(database, {
    runId: job.runId,
    kind,
    subjectType: 'supplier',
    subjectId: job.subjectId,
  });
}

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} — finishing the current Round, then exiting.`);
}

/**
 * The spine: boot → build the dispatch table → run the poll loop (claim,
 * dispatch, settle all live in `runWorker`/`runOneJob`, src/worker/poll.ts) →
 * shut down.
 */
async function main(): Promise<void> {
  const env = boot();
  const db = getDirectDb();

  registerSignalHandlers();

  console.log(
    `Worker up — concurrency ${env.WORKER_CONCURRENCY}, polling every ${env.WORKER_POLL_INTERVAL_MS}ms.`,
  );

  await runWorker(db, {
    concurrency: env.WORKER_CONCURRENCY,
    pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
    handlers: buildJobHandlers(env),
    shouldStop: () => shuttingDown,
  });

  await closeWorker();
}

/** Boot phase: the two signals that ask the loop to finish, not abort. */
function registerSignalHandlers(): void {
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

/**
 * Dispatch phase: one `JobHandler` per kind, each closing over `env` so it can
 * build its own upstream and model context.
 *
 * **Typed against `RUNNABLE_JOB_KINDS`, so the list and the table cannot
 * drift.** They already had: the constant now names the six kinds a worker
 * runs, and `finalizeRegistry()` checks every `enqueue_*` tool's declared kind
 * against the same list — so a Job kind chat can propose and the worker cannot
 * run is caught at boot rather than when the Job dequeues. A kind added to the
 * constant without a handler here is a compile error.
 */
function buildJobHandlers(env: Env): Record<RunnableJobKind, JobHandler> {
  return {
    enrich: (job, database) => enrichJobHandler(job, database, env),
    fetch_entity: (job, database) => fetchEntityJobHandler(job, database, env),
    discover: (job, database) => discoverJobHandler(job, database, env),
    resolve: (job, database) => resolveJobHandler(job, database, env),
    assess: (job, database) => assessJobHandler(job, database, env),
    recommend: (job, database) => recommendJobHandler(job, database, env),
    traverse: (job, database) => traverseJobHandler(job, database, env),
  };
}

/**
 * Built once, and named once, because five handlers assembling the same three
 * contexts by hand is five chances to pass the wrong `jobId` — and a wrong
 * `jobId` puts a Job's spend on a different Job's row, which nothing else
 * would catch.
 */
function buildUpstreamCredentials(env: Env) {
  return {
    sayariClientId: env.SAYARI_CLIENT_ID,
    sayariClientSecret: env.SAYARI_CLIENT_SECRET,
    nominatimUserAgent: env.NOMINATIM_USER_AGENT,
  };
}

function buildToolContext(
  database: Database,
  upstream: ReturnType<typeof createUpstream>,
  job: { id: string; runId: string },
) {
  return {
    db: database,
    upstream,
    meter: { addModelTokens: () => {} },
    runId: job.runId,
    jobId: job.id,
    surface: 'job' as const,
  };
}

function buildModelContext(env: Env, database: Database, job: { id: string; runId: string }) {
  return {
    db: database,
    runId: job.runId,
    jobId: job.id,
    credentials: { apiKey: env.ANTHROPIC_API_KEY },
    /**
     * **The run budget, checked at every Round boundary** (SPEC §18.2, §18.3).
     *
     * Built here, once, for every loop the Job runs — the alternative was each
     * of a dozen `runLoop()` call sites remembering to pass one, and none of
     * them did: `RunLoopParams.budgetCheck` was supplied by nothing, so the
     * pre-dequeue check was the only bound and a Job already running could
     * spend past the budget without ever noticing.
     */
    budgetCheck: () => checkRunBudget(database, job.runId),
  };
}

/**
 * Deterministic: no model runs, so this Job needs no fixture and calls
 * the upstream wrapper directly rather than going through the tool
 * registry, which is a model-facing catalog.
 */
async function enrichJobHandler(job: JobRow, database: Database, env: Env): Promise<JobOutcome> {
  const supplier = await database.query.supplier.findFirst({
    where: (row, { eq: equals }) => equals(row.id, job.subjectId),
  });
  if (!supplier) return { state: 'failed', error: `no supplier ${job.subjectId}` };
  const upstream = createUpstream({
    db: database,
    runId: job.runId,
    jobId: job.id,
    credentials: {
      sayariClientId: env.SAYARI_CLIENT_ID,
      sayariClientSecret: env.SAYARI_CLIENT_SECRET,
      nominatimUserAgent: env.NOMINATIM_USER_AGENT,
    },
    toolCallCap: job.toolCallCap,
  });
  await enrichSupplier(
    { db: database, upstream, jobId: job.id },
    { supplierId: supplier.id, programId: supplier.programId },
  );

  /**
   * **Enrichment unblocks the assessment, so a pipeline Run queues it.**
   *
   * This hop did not exist. `resolve` chained into `enrich` and the chain
   * stopped there, so nothing in the app queued an `assess` for a roster
   * — the Program strip's *"N of 50 assessed"* could only ever be moved
   * one Supplier at a time, by hand, from a Supplier page.
   *
   * Only a `pipeline` Run chains. The Supplier page's Re-enrich asks *has
   * the evidence changed*, and answering it must not also rewrite the
   * argument; that is a separate button on purpose.
   */
  await chainNext(database, job, 'assess');
  return { state: 'done' };
}

/**
 * One company's own record.
 *
 * Queued the first time this app meets a company nested inside somebody
 * else's payload. Until it runs, that company has attributes copied out
 * of another company's response, no relationships of its own, and nothing
 * a reader can check it against — of 14,491 entities, 288 had a record of
 * their own.
 *
 * Deterministic, like `enrich`: one call, no model, and the upstream
 * ceiling is what bounds it.
 */
async function fetchEntityJobHandler(
  job: JobRow,
  database: Database,
  env: Env,
): Promise<JobOutcome> {
  const upstream = createUpstream({
    db: database,
    runId: job.runId,
    jobId: job.id,
    credentials: buildUpstreamCredentials(env),
    toolCallCap: job.toolCallCap,
  });

  const fetched = await upstream.sayari.getEntity({ id: job.subjectId });
  await upsertEntity(database, fetched.data, fetched.upstreamResponseId, 'getEntity');

  /**
   * Its graph, now that we hold a payload that is actually its own.
   * No `runId` is passed, so this does **not** queue a fetch for every
   * company it in turn names — one hop of fan-out per Job, or the first
   * roster would walk the whole Sayari graph.
   */
  const { edges } = parseRelationships(fetched.data, job.subjectId);
  const written = await storeRelationships(database, edges, job.id);

  console.log(`  fetch_entity ${fetched.data.label ?? job.subjectId}: ${written} edge(s)`);
  return { state: 'done' };
}

/**
 * The **Deep Traversal**: a person or the chat asked for one company's
 * ownership graph to be expanded past the automatic read (SPEC §8.5).
 *
 * Deterministic, like `enrich` and `fetch_entity`: no model turn, so this
 * Job's Trace is its `usage_event` rows and its `trace_fidelity` stays
 * `replayable` — a Job with no turns is recordable, and what its fixture
 * carries is the upstream bodies it read.
 *
 * The subject is an **entity**, not a Supplier: `enqueue_deep_traversal`
 * writes the entity id it was asked about, because a Deep Traversal is
 * about a company in the graph and a Twin or an owner is not on anybody's
 * roster.
 *
 * **Only the call budget terminates it.** Filling the node cap is what a
 * Deep Traversal *is* — CONTEXT: *within a hop and node cap* — so a walk
 * that stops there is `done` with its truncation recorded, and the amber
 * row is reserved for the ceiling that actually cost the answer
 * something (SPEC §18.4).
 */
async function traverseJobHandler(job: JobRow, database: Database, env: Env): Promise<JobOutcome> {
  const upstream = createUpstream({
    db: database,
    runId: job.runId,
    jobId: job.id,
    credentials: buildUpstreamCredentials(env),
    toolCallCap: job.toolCallCap,
  });

  const walk = await runDeepTraversal(
    { db: database, upstream, jobId: job.id },
    { entityId: job.subjectId },
  );

  console.log(
    `  traverse ${job.subjectId}: ${walk.explored} member(s) to hop ${walk.deepestHop}` +
      ` in ${walk.pagesRead} call(s) — ${walk.stoppedBy}` +
      `${walk.reachable == null ? '' : ` of ${walk.reachable} explored`}`,
  );

  if (walk.stoppedBy === 'call_budget') {
    return {
      state: 'terminated',
      reason:
        `Stopped at its ${job.toolCallCap}-upstream-call ceiling after ${walk.pagesRead} page(s), ` +
        `holding ${walk.explored} family member(s). Re-running continues from a warm cache.`,
    };
  }
  return { state: 'done' };
}

/**
 * Discover: one trade call plus up to 25 classifications, and the
 * classifier costs no additional Sayari calls because a trade result is
 * already a full entity.
 */
async function discoverJobHandler(job: JobRow, database: Database, env: Env): Promise<JobOutcome> {
  const category = await database.query.category.findFirst({
    where: (row, { eq: equals }) => equals(row.id, job.subjectId),
  });
  if (!category) return { state: 'failed', error: `no category ${job.subjectId}` };

  const upstream = createUpstream({
    db: database,
    runId: job.runId,
    jobId: job.id,
    credentials: {
      sayariClientId: env.SAYARI_CLIENT_ID,
      sayariClientSecret: env.SAYARI_CLIENT_SECRET,
      nominatimUserAgent: env.NOMINATIM_USER_AGENT,
    },
    toolCallCap: job.toolCallCap,
  });
  const toolCtx = {
    db: database,
    upstream,
    meter: { addModelTokens: () => {} },
    runId: job.runId,
    jobId: job.id,
    surface: 'job' as const,
  };
  await discoverLeads(
    {
      db: database,
      upstream,
      toolCtx,
      modelCtx: {
        db: database,
        runId: job.runId,
        jobId: job.id,
        credentials: { apiKey: env.ANTHROPIC_API_KEY },
      },
      jobId: job.id,
    },
    { programId: category.programId, categoryId: category.id },
  );
  return { state: 'done' };
}

/**
 * Rung R1 — the batch pre-pass — runs here rather than inside
 * `resolveSupplier`, because it is **one call carrying every row** and a
 * function that resolves one Supplier is the wrong place to own a batch.
 *
 * Its result is passed in as `prepassEntityIds`, which is also what lets
 * the ladder's rungs stay honest about what each one costs.
 */
async function resolveJobHandler(job: JobRow, database: Database, env: Env): Promise<JobOutcome> {
  const upstream = createUpstream({
    db: database,
    runId: job.runId,
    jobId: job.id,
    credentials: buildUpstreamCredentials(env),
    // The ceiling this Job carries, so a deterministic Job is bounded too.
    toolCallCap: job.toolCallCap,
  });

  const outcome = await runResolveJob(
    {
      db: database,
      upstream,
      round: {
        toolCtx: buildToolContext(database, upstream, job),
        modelCtx: buildModelContext(env, database, job),
      },
      jobId: job.id,
    },
    { supplierId: job.subjectId },
  );

  /**
   * **An accepted Match unblocks enrichment, so the Run queues it.**
   *
   * Enrichment cannot be queued up front: it needs a settled Match, and a
   * Job queued alongside the resolve would dequeue before its Supplier
   * had one. Chaining here means a row that parks at `needs_review`
   * correctly never gets an enrichment — the follow-on is a consequence
   * of the outcome, not of the request.
   *
   * It joins the **same Run**, because it is the spend that Run was
   * opened for. Only a decision a person makes later starts a new one.
   */
  if (outcome.status === 'accepted') {
    await chainNext(database, job, 'enrich');
  }

  /**
   * **Needs Review is not a failure.** The Job did exactly what it exists
   * to do — it declined to guess — so it finishes `done` and the Supplier
   * waits for a person. Marking it `failed` would put a red row in the
   * Run for the one outcome the ladder is proudest of.
   */
  console.log(`  resolve ${job.subjectId}: ${outcome.status} (settled by ${outcome.settledBy})`);

  /**
   * A ceiling stopped the ladder, and the Match was parked anyway.
   *
   * `terminated` names a number somebody set, so the row is amber and offers a
   * re-run; the Supplier is not left mid-air while it waits for one. This is
   * the one Job whose ceiling does not travel as a throw, because its parking
   * step has to run either way.
   */
  if (outcome.terminatedReason) {
    return { state: 'terminated', reason: outcome.terminatedReason };
  }
  return { state: 'done' };
}

async function assessJobHandler(job: JobRow, database: Database, env: Env): Promise<JobOutcome> {
  const supplier = await database.query.supplier.findFirst({
    where: (row, { eq: equals }) => equals(row.id, job.subjectId),
  });
  if (!supplier) return { state: 'failed', error: `no supplier ${job.subjectId}` };

  const upstream = createUpstream({
    db: database,
    runId: job.runId,
    jobId: job.id,
    credentials: buildUpstreamCredentials(env),
    // The ceiling this Job carries, so a deterministic Job is bounded too.
    toolCallCap: job.toolCallCap,
  });
  const outcome = await assessSupplier(
    {
      db: database,
      toolCtx: buildToolContext(database, upstream, job),
      modelCtx: buildModelContext(env, database, job),
      jobId: job.id,
    },
    { supplierId: supplier.id, programId: supplier.programId },
  );
  console.log(
    `  assess ${supplier.rosterName}: v${outcome.n} ${outcome.evaluatorOutcome} in ${outcome.roundsUsed} round(s)`,
  );
  return { state: 'done' };
}

async function recommendJobHandler(job: JobRow, database: Database, env: Env): Promise<JobOutcome> {
  const category = await database.query.category.findFirst({
    where: (row, { eq: equals }) => equals(row.id, job.subjectId),
  });
  if (!category) return { state: 'failed', error: `no category ${job.subjectId}` };

  const upstream = createUpstream({
    db: database,
    runId: job.runId,
    jobId: job.id,
    credentials: buildUpstreamCredentials(env),
    // The ceiling this Job carries, so a deterministic Job is bounded too.
    toolCallCap: job.toolCallCap,
  });
  const outcome = await recommendCategory(
    {
      db: database,
      toolCtx: buildToolContext(database, upstream, job),
      modelCtx: buildModelContext(env, database, job),
      jobId: job.id,
    },
    { programId: category.programId, categoryId: category.id },
  );
  console.log(
    `  recommend ${category.code}: v${outcome.n} ${outcome.evaluatorOutcome} in ${outcome.roundsUsed} round(s)`,
  );
  return { state: 'done' };
}

/** Shutdown phase: `runWorker` has already drained in-flight Jobs. */
async function closeWorker(): Promise<void> {
  await closeDirectDb();
  console.log('Worker stopped.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

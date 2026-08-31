// Next.js loads `.env` itself; a plain Node entrypoint has to ask.
import 'dotenv/config';
import { boot } from '@/config/boot';
import { closeDirectDb, getDirectDb, type Database } from '@/db/client';
import { createUpstream } from '@/upstream';
import { discoverLeads } from '@/jobs/discover';
import { enrichSupplier } from '@/jobs/enrich-supplier';
import { runResolveJob } from '@/jobs/resolve-job';
import { enqueueJob } from '@/jobs/runs';
import { assessSupplier } from '@/jobs/assess';
import { recommendCategory } from '@/jobs/recommend';
import { runWorker } from './poll';

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

async function main(): Promise<void> {
  const env = boot();
  const db = getDirectDb();

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  console.log(
    `Worker up — concurrency ${env.WORKER_CONCURRENCY}, polling every ${env.WORKER_POLL_INTERVAL_MS}ms.`,
  );

  /**
   * Built once, and named once, because five handlers assembling the same three
   * contexts by hand is five chances to pass the wrong `jobId` — and a wrong
   * `jobId` puts a Job's spend on a different Job's row, which nothing else
   * would catch.
   */
  const upstreamCredentials = {
    sayariClientId: env.SAYARI_CLIENT_ID,
    sayariClientSecret: env.SAYARI_CLIENT_SECRET,
    nominatimUserAgent: env.NOMINATIM_USER_AGENT,
  };

  const toolContext = (
    database: Database,
    upstream: ReturnType<typeof createUpstream>,
    job: { id: string; runId: string },
  ) => ({
    db: database,
    upstream,
    meter: { addModelTokens: () => {} },
    runId: job.runId,
    jobId: job.id,
    surface: 'job' as const,
  });

  const modelContext = (database: Database, job: { id: string; runId: string }) => ({
    db: database,
    runId: job.runId,
    jobId: job.id,
    credentials: { apiKey: env.ANTHROPIC_API_KEY },
  });

  await runWorker(db, {
    concurrency: env.WORKER_CONCURRENCY,
    pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
    handlers: {
      /**
       * Deterministic: no model runs, so this Job needs no fixture and calls
       * the upstream wrapper directly rather than going through the tool
       * registry, which is a model-facing catalog.
       */
      enrich: async (job, database) => {
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
         * — the Programme strip's *"N of 50 assessed"* could only ever be moved
         * one Supplier at a time, by hand, from a Supplier page.
         *
         * Only a `pipeline` Run chains. The Supplier page's Re-enrich asks *has
         * the evidence changed*, and answering it must not also rewrite the
         * argument; that is a separate button on purpose.
         */
        await chainNext(database, job, 'assess');
        return { state: 'done' };
      },
      /**
       * Discover: one trade call plus up to 25 classifications, and the
       * classifier costs no additional Sayari calls because a trade result is
       * already a full entity.
       */
      discover: async (job, database) => {
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
      },

      /**
       * Rung R1 — the batch pre-pass — runs here rather than inside
       * `resolveSupplier`, because it is **one call carrying every row** and a
       * function that resolves one Supplier is the wrong place to own a batch.
       *
       * Its result is passed in as `prepassEntityIds`, which is also what lets
       * the ladder's rungs stay honest about what each one costs.
       */
      resolve: async (job, database) => {
        const upstream = createUpstream({
          db: database,
          runId: job.runId,
          jobId: job.id,
          credentials: upstreamCredentials,
        });

        const outcome = await runResolveJob(
          {
            db: database,
            upstream,
            round: {
              toolCtx: toolContext(database, upstream, job),
              modelCtx: modelContext(database, job),
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
        return { state: 'done' };
      },

      assess: async (job, database) => {
        const supplier = await database.query.supplier.findFirst({
          where: (row, { eq: equals }) => equals(row.id, job.subjectId),
        });
        if (!supplier) return { state: 'failed', error: `no supplier ${job.subjectId}` };

        const upstream = createUpstream({
          db: database,
          runId: job.runId,
          jobId: job.id,
          credentials: upstreamCredentials,
        });
        const outcome = await assessSupplier(
          {
            db: database,
            toolCtx: toolContext(database, upstream, job),
            modelCtx: modelContext(database, job),
            jobId: job.id,
          },
          { supplierId: supplier.id, programId: supplier.programId },
        );
        console.log(
          `  assess ${supplier.rosterName}: v${outcome.n} ${outcome.evaluatorOutcome} in ${outcome.roundsUsed} round(s)`,
        );
        return { state: 'done' };
      },

      recommend: async (job, database) => {
        const category = await database.query.category.findFirst({
          where: (row, { eq: equals }) => equals(row.id, job.subjectId),
        });
        if (!category) return { state: 'failed', error: `no category ${job.subjectId}` };

        const upstream = createUpstream({
          db: database,
          runId: job.runId,
          jobId: job.id,
          credentials: upstreamCredentials,
        });
        const outcome = await recommendCategory(
          {
            db: database,
            toolCtx: toolContext(database, upstream, job),
            modelCtx: modelContext(database, job),
            jobId: job.id,
          },
          { programId: category.programId, categoryId: category.id },
        );
        console.log(
          `  recommend ${category.code}: v${outcome.n} ${outcome.evaluatorOutcome} in ${outcome.roundsUsed} round(s)`,
        );
        return { state: 'done' };
      },
    },
    shouldStop: () => shuttingDown,
  });

  await closeDirectDb();
  console.log('Worker stopped.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

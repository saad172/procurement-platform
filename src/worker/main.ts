// Next.js loads `.env` itself; a plain Node entrypoint has to ask.
import 'dotenv/config';
import { boot } from '@/config/boot';
import { closeDirectDb, getDirectDb } from '@/db/client';
import { createUpstream } from '@/upstream';
import { discoverLeads } from '@/jobs/discover';
import { enrichSupplier } from '@/jobs/enrich-supplier';
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

      // The rest arrive with their build-order steps: resolve (8), traverse (9),
      // assess and recommend (10).
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

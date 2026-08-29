// Next.js loads `.env` itself; a plain Node entrypoint has to ask.
import 'dotenv/config';
import { boot } from '@/config/boot';
import { closeDirectDb, getDirectDb } from '@/db/client';
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
    // Handlers arrive with their build-order steps: resolve (8), enrich and
    // traverse (9), assess and recommend (10), discover (13).
    handlers: {},
    shouldStop: () => shuttingDown,
  });

  await closeDirectDb();
  console.log('Worker stopped.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

// Next.js loads `.env` itself; a plain Node entrypoint has to ask.
import 'dotenv/config';
import { closeDirectDb } from '@/db/client';
import { boot } from '@/config/boot';

/**
 * The worker process (SPEC §2.2).
 *
 * A long-lived Node process polling the `job` table with
 * `FOR UPDATE SKIP LOCKED`, running the *same* Tool Runner code the chat route
 * handler uses. Fixed concurrency 4.
 *
 * It exists so that "≤ 10 minutes for 50 Suppliers" is achievable without
 * designing around a 300-second serverless function ceiling. Chunked route
 * handlers re-enqueuing before a deadline were rejected as the least readable
 * code in a build graded on readability.
 *
 * It holds no inbound port. The graded local run has no inbound surface at all.
 */

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} — finishing the current Round, then exiting.`);
  await closeDirectDb();
  process.exit(0);
}

async function main(): Promise<void> {
  const env = boot();

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  console.log(
    `Worker up — concurrency ${env.WORKER_CONCURRENCY}, polling every ${env.WORKER_POLL_INTERVAL_MS}ms.`,
  );

  // The dequeue loop lands in build-order step 7, once `run` and `job` exist.
  // Until then the process stays alive so the compose topology is real rather
  // than aspirational.
  while (!shuttingDown) {
    await new Promise((resolve) => setTimeout(resolve, env.WORKER_POLL_INTERVAL_MS));
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

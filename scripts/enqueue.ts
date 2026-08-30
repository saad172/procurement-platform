// Next.js loads `.env` itself; a plain Node entrypoint has to ask.
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { closeDirectDb, getDirectDb } from '@/db/client';
import * as t from '@/db/schema';
import { enqueueJob, openRun } from '@/jobs/runs';
import type { JobKind } from '@/config/constants';

/**
 * Queues one Job for the worker to pick up.
 *
 *   pnpm enqueue resolve Yazaki
 *   pnpm enqueue assess "Sumitomo Electric"
 *   pnpm enqueue recommend HAR
 *   pnpm enqueue discover BAT
 *
 * **The point is to drive the real path.** The smoke scripts call a Job's
 * function directly, which is right for probing one layer — but they pass no
 * `jobId`, so nothing writes a Trace, and a Job with no Trace cannot become a
 * fixture. Queueing and letting the worker claim it exercises what production
 * runs: the dequeue, the caps, the Trace, the usage rows.
 *
 * Run `pnpm worker` in another terminal, or after this.
 */

/** Suppliers are named; Categories are coded. The kind says which to look up. */
const SUBJECT_BY_KIND: Record<JobKind, 'supplier' | 'category'> = {
  resolve: 'supplier',
  enrich: 'supplier',
  assess: 'supplier',
  traverse: 'supplier',
  recommend: 'category',
  discover: 'category',
  dossier: 'supplier',
};

const TRIGGER_BY_KIND: Record<JobKind, Parameters<typeof openRun>[1]['trigger']> = {
  resolve: 'full',
  enrich: 'full',
  assess: 'reassess',
  traverse: 'traverse',
  recommend: 'rerun_recommendation',
  discover: 'discover',
  dossier: 'dossier',
};

async function main(): Promise<void> {
  const kind = process.argv[2] as JobKind | undefined;
  const subject = process.argv[3];

  if (!kind || !subject || !(kind in SUBJECT_BY_KIND)) {
    console.error(
      [
        'Usage: pnpm enqueue <kind> <subject>',
        `  kinds:    ${Object.keys(SUBJECT_BY_KIND).join(', ')}`,
        '  subject:  a Supplier roster name, or a Category code',
        '',
        '  e.g. pnpm enqueue resolve Yazaki',
        '       pnpm enqueue recommend HAR',
      ].join('\n'),
    );
    process.exitCode = 1;
    return;
  }

  const db = getDirectDb();
  try {
    const program = await db.query.program.findFirst();
    if (!program) {
      console.error('Seed the database first: pnpm db:seed');
      process.exitCode = 1;
      return;
    }

    const subjectType = SUBJECT_BY_KIND[kind];
    const row =
      subjectType === 'supplier'
        ? await db.query.supplier.findFirst({ where: eq(t.supplier.rosterName, subject) })
        : await db.query.category.findFirst({ where: eq(t.category.code, subject) });

    if (!row) {
      console.error(`No ${subjectType} named "${subject}" on this programme.`);
      process.exitCode = 1;
      return;
    }

    const runId = await openRun(db, {
      programId: program.id,
      trigger: TRIGGER_BY_KIND[kind],
      subjectLabel: `${kind} ${subject}`,
      // One subject, so the Run's budget is one Supplier's worth. A Run opened
      // with no count carries no budget at all, which is right for chat and
      // wrong here — a fixture recording should meet the same ceiling a real
      // run would.
      supplierCount: 1,
    });
    const jobId = await enqueueJob(db, { runId, kind, subjectType, subjectId: row.id });

    console.warn(`queued ${kind} "${subject}"\n  job ${jobId}\n  run ${runId}\n\nRun \`pnpm worker\` to process it.`);
  } finally {
    await closeDirectDb();
  }
}

void main();

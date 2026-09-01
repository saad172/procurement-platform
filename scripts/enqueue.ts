// Next.js loads `.env` itself; a plain Node entrypoint has to ask.
import 'dotenv/config';
import { and, eq } from 'drizzle-orm';
import { closeDirectDb, getDirectDb } from '@/db/client';
import * as t from '@/db/schema';
import { enqueueJob, openRun } from '@/jobs/runs';
import type { JobKind } from '@/config/constants';
import { seedTestProgram } from '@/db/seed-test-program';
import { TEST_PROGRAM } from '@/db/seed-data/test-program';
import { PROGRAM } from '@/db/seed-data/program';

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
/**
 * `fetch_entity` is absent on purpose: its subject is an entity id, not a name
 * a person types, and the system queues it the first time it meets a company
 * nested in somebody else's payload. The guard below rejects it by name.
 */
const SUBJECT_BY_KIND: Partial<Record<JobKind, 'supplier' | 'category'>> = {
  resolve: 'supplier',
  enrich: 'supplier',
  assess: 'supplier',
  traverse: 'supplier',
  recommend: 'category',
  discover: 'category',
  dossier: 'supplier',
};

const TRIGGER_BY_KIND: Partial<Record<JobKind, Parameters<typeof openRun>[1]['trigger']>> = {
  resolve: 'full',
  enrich: 'full',
  assess: 'reassess',
  traverse: 'traverse',
  recommend: 'rerun_recommendation',
  discover: 'discover',
  dossier: 'dossier',
};

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  const kind = args[0] as JobKind | undefined;
  const subject = args[1];

  if (!kind || !subject || !(kind in SUBJECT_BY_KIND)) {
    console.error(
      [
        'Usage: pnpm enqueue <kind> <subject>',
        `  kinds:    ${Object.keys(SUBJECT_BY_KIND).join(', ')}`,
        '  subject:  a Supplier roster name, or a Category code',
        '',
        '  --test-program  use the arranged fixtures program (SPEC §19.3)',
        '',
        '  e.g. pnpm enqueue resolve Yazaki',
        '       pnpm enqueue recommend HAR',
        '       pnpm enqueue resolve Rosoboronexport --test-program',
      ].join('\n'),
    );
    process.exitCode = 1;
    return;
  }

  /**
   * Narrowed once. The guard above rejects any kind the two tables do not
   * carry, so from here both lookups are known to be present — and a kind the
   * system queues for itself, like `fetch_entity`, never reaches this line.
   */
  const subjectType = SUBJECT_BY_KIND[kind]!;
  const trigger = TRIGGER_BY_KIND[kind]!;

  const db = getDirectDb();
  try {
    /**
     * `--test-program` reaches the arranged Program (SPEC §19.3), which is
     * seeded here rather than at boot so the approved seed stays untouched.
     */
    const useTestProgram = process.argv.includes('--test-program');
    if (useTestProgram) await seedTestProgram(db);

    const program = useTestProgram
      ? await db.query.program.findFirst({ where: eq(t.program.id, TEST_PROGRAM.id) })
      : await db.query.program.findFirst({ where: eq(t.program.name, PROGRAM.name) });
    if (!program) {
      console.error('Seed the database first: pnpm db:seed');
      process.exitCode = 1;
      return;
    }

    // Scoped to the Program, so two Programs may hold the same name.
    const row =
      subjectType === 'supplier'
        ? await db.query.supplier.findFirst({
            where: and(eq(t.supplier.rosterName, subject), eq(t.supplier.programId, program.id)),
          })
        : await db.query.category.findFirst({
            where: and(eq(t.category.code, subject), eq(t.category.programId, program.id)),
          });

    if (!row) {
      console.error(`No ${subjectType} named "${subject}" on this program.`);
      process.exitCode = 1;
      return;
    }

    const runId = await openRun(db, {
      programId: program.id,
      trigger,
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

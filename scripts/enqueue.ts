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
 *   pnpm enqueue pairs PWR
 *   pnpm enqueue trade Yazaki HAR
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
 *
 * `pairs` and `trade` are both here too (network spec §7, §4.3; tickets 04,
 * 05), matching each Job's own `enqueue_*` tool subject: `pairs` runs over a
 * Category's whole roster (`enqueue_check_every_pair`), `trade` over one
 * accepted Supplier's Profile (`enqueue_trade` — `subjectType: 'supplier'`,
 * resolved to its entity id by the worker, `resolveTradeEntityId`,
 * BUILD-NOTES finding 161).
 */
const SUBJECT_BY_KIND: Partial<Record<JobKind, 'supplier' | 'category'>> = {
  resolve: 'supplier',
  enrich: 'supplier',
  assess: 'supplier',
  traverse: 'supplier',
  recommend: 'category',
  discover: 'category',
  dossier: 'supplier',
  pairs: 'category',
  trade: 'supplier',
};

const TRIGGER_BY_KIND: Partial<Record<JobKind, Parameters<typeof openRun>[1]['trigger']>> = {
  resolve: 'full',
  enrich: 'full',
  assess: 'reassess',
  traverse: 'traverse',
  recommend: 'rerun_recommendation',
  discover: 'discover',
  dossier: 'dossier',
  pairs: 'pairs',
  trade: 'trade',
};

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  const kind = args[0] as JobKind | undefined;
  const subject = args[1];
  /**
   * `trade` alone takes a third positional argument — a Category code — for
   * the fourth call's HS-code filter (`enqueue_trade`'s own `categoryId`
   * input, `src/tools/catalog/enqueues.ts`). Every other kind here ignores a
   * third argument entirely.
   */
  const tradeCategoryCode = args[2];

  if (!kind || !subject || !(kind in SUBJECT_BY_KIND) || (kind === 'trade' && !tradeCategoryCode)) {
    console.error(
      [
        'Usage: pnpm enqueue <kind> <subject> [category-code]',
        `  kinds:    ${Object.keys(SUBJECT_BY_KIND).join(', ')}`,
        '  subject:  a Supplier roster name, or a Category code',
        '  [category-code]:  required for trade only — the Category whose HS lines filter call 4',
        '',
        '  --test-program  use the arranged fixtures program (SPEC §19.3)',
        '',
        '  e.g. pnpm enqueue resolve Yazaki',
        '       pnpm enqueue recommend HAR',
        '       pnpm enqueue pairs PWR',
        '       pnpm enqueue trade Yazaki HAR',
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

    /**
     * Mirrors `enqueue_trade`'s own `params: { categoryId }` shape exactly
     * (`src/tools/catalog/enqueues.ts`), so a `trade` Job queued from here is
     * indistinguishable in the `job` table from one a real chat confirm would
     * have produced.
     */
    let params: Record<string, unknown> | undefined;
    if (kind === 'trade') {
      const tradeCategory = await db.query.category.findFirst({
        where: and(eq(t.category.code, tradeCategoryCode!), eq(t.category.programId, program.id)),
      });
      if (!tradeCategory) {
        console.error(`No category coded "${tradeCategoryCode}" on this program.`);
        process.exitCode = 1;
        return;
      }
      params = { categoryId: tradeCategory.id };
    }

    const runId = await openRun(db, {
      programId: program.id,
      trigger,
      subjectLabel: kind === 'trade' ? `${kind} ${subject} (${tradeCategoryCode})` : `${kind} ${subject}`,
      // One subject, so the Run's budget is one Supplier's worth. A Run opened
      // with no count carries no budget at all, which is right for chat and
      // wrong here — a fixture recording should meet the same ceiling a real
      // run would.
      supplierCount: 1,
    });
    const jobId = await enqueueJob(db, { runId, kind, subjectType, subjectId: row.id, params });

    console.warn(
      `queued ${kind} "${subject}"\n  job ${jobId}\n  run ${runId}\n\nRun \`pnpm worker\` to process it.`,
    );
  } finally {
    await closeDirectDb();
  }
}

void main();

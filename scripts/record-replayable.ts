// Next.js loads `.env` itself; a plain Node entrypoint has to ask.
import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { eq } from 'drizzle-orm';
import * as t from '@/db/schema';
import { loadEnv } from '@/config/env';
import { assessSupplier } from '@/jobs/assess';
import { recommendCategory } from '@/jobs/recommend';
import { loadFixture } from '@/fixtures/load';
import { replayFetch } from '@/fixtures/replay-fetch';
import { replayUpstream } from '@/fixtures/replay-upstream';
import { fixtureDigest, recordFixture, serializeFixture } from '@/fixtures/record';
import { resetAnthropicClients } from '@/model/client';
import { closeTestDb, getTestDb, testDatabaseIsUp } from '../tests/support/test-db';
import { resetDerived } from '../tests/support/reset';
import { buildAssessableSupplier, openJob } from '../tests/support/pipeline';

/**
 * Records a model fixture **from the state its replay reconstructs**.
 *
 *     pnpm fixtures:record-replayable assess
 *     pnpm fixtures:record-replayable recommend
 *
 * ## Why this exists rather than `enqueue` + `worker` + `fixtures:record`
 *
 * That flow records from the **development** database, which holds fifty
 * Suppliers, their Matches, their families and three published Assessments. The
 * replay starts from `resetDerived()` plus one Supplier rebuilt out of two other
 * fixtures. Those are different databases, so a tool that reads anything the
 * two do not share returns a different result, the next request differs, and
 * the replay misses — BUILD-NOTES finding 85.
 *
 * That is not a theory here. `assess/published-with-objections` was recorded
 * through the worker, replayed four turns cleanly, and missed on the fifth:
 *
 * ```
 * The next unserved turn is n=5 (assess, round 1)
 * Turns served so far: 1, 3, 2, 4.
 * ```
 *
 * ## What it does instead
 *
 * It calls the **same helpers the replay calls**, in the same order, against
 * the **test** database — `resetDerived`, then `buildAssessableSupplier` — and
 * only then runs the Job live. Recording and replay cannot drift, because
 * neither one owns a copy of the starting state: they import the same function.
 *
 * **It spends Anthropic tokens** — that is the whole point, and it is why this
 * is a script rather than a test. Sayari costs nothing: every upstream read is
 * served from the fixtures the helper seeds.
 */

const FIXTURE_DIR = join(process.cwd(), 'tests', 'fixtures');

/** The roster row every replay in this family is built around. */
const ROSTER_NAME = 'Yazaki';

/** The Category `recommend/one-category` argues over. */
const CATEGORY_CODE = 'HAR';

const RECIPES = {
  assess: 'assess/published-with-objections',
  recommend: 'recommend/one-category',
} as const;

type Recipe = keyof typeof RECIPES;

async function main(): Promise<void> {
  const recipe = process.argv[2] as Recipe | undefined;
  if (!recipe || !(recipe in RECIPES)) {
    console.error(
      [
        'Usage: pnpm fixtures:record-replayable <recipe>',
        `  recipes: ${Object.keys(RECIPES).join(', ')}`,
        '',
        '  Records from the state the replay reconstructs, against the TEST database.',
        '  It spends Anthropic tokens and no Sayari credits.',
      ].join('\n'),
    );
    process.exitCode = 1;
    return;
  }

  if (!(await testDatabaseIsUp())) {
    console.error('The test database is not up. Start it, then run this again.');
    process.exitCode = 1;
    return;
  }

  const env = loadEnv();
  const db = await getTestDb();
  const name = RECIPES[recipe];

  try {
    // Exactly what the replay does, by calling exactly what the replay calls.
    await resetDerived(db);
    const { supplierId, programId, runId } = await buildAssessableSupplier(db, ROSTER_NAME);
    resetAnthropicClients();

    const jobId =
      recipe === 'assess'
        ? await recordAssess(db, { supplierId, programId, runId, apiKey: env.ANTHROPIC_API_KEY })
        : await recordRecommend(db, {
            supplierId,
            programId,
            runId,
            apiKey: env.ANTHROPIC_API_KEY,
          });

    const fixture = await recordFixture(db, {
      name,
      jobId,
      recordedAt: new Date().toISOString(),
    });
    const path = join(FIXTURE_DIR, `${name}.json`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, serializeFixture(fixture));

    console.warn(
      [
        '',
        `  ${name}`,
        `    ${fixture.turns.length} turn(s), ${fixture.upstream.length} cached upstream row(s)`,
        `    loops: ${Object.keys(fixture.manifest.loopHashes).join(', ') || 'none'}`,
        `    digest ${fixtureDigest(fixture).slice(0, 16)}…`,
        `    written to ${path}`,
        '',
      ].join('\n'),
    );
  } finally {
    await closeTestDb();
  }
}

type Args = { supplierId: string; programId: string; runId: string; apiKey: string };
type Db = Awaited<ReturnType<typeof getTestDb>>;

const toolCtx = (db: Db, runId: string, jobId: string) => ({
  db,
  upstream: replayUpstream(db, runId, jobId),
  meter: { addModelTokens: () => {} },
  runId,
  jobId,
  surface: 'job' as const,
});

async function recordAssess(db: Db, args: Args): Promise<string> {
  const jobId = await openJob(db, args.runId, 'assess', args.supplierId);
  console.warn(`  assessing "${ROSTER_NAME}" live — this spends tokens`);
  const result = await assessSupplier(
    {
      db,
      toolCtx: toolCtx(db, args.runId, jobId),
      modelCtx: { db, runId: args.runId, jobId, credentials: { apiKey: args.apiKey } },
      jobId,
    },
    { supplierId: args.supplierId, programId: args.programId },
  );
  console.warn(
    `  version ${result.n} · ${result.evaluatorOutcome} · ${result.roundsUsed} round(s)`,
  );
  return jobId;
}

/**
 * `recommend` needs a published Assessment on the Shortlist first, and the
 * replay gets one by replaying the assess fixture. So does this — replaying it
 * costs nothing and guarantees the Shortlist this records against is the one
 * the replay will rebuild.
 */
async function recordRecommend(db: Db, args: Args): Promise<string> {
  const assessFixture = await loadFixture(RECIPES.assess);
  const assessJob = await openJob(db, args.runId, 'assess', args.supplierId);
  await assessSupplier(
    {
      db,
      toolCtx: toolCtx(db, args.runId, assessJob),
      modelCtx: {
        db,
        runId: args.runId,
        jobId: assessJob,
        credentials: { apiKey: 'not-a-key', fetch: replayFetch(assessFixture) },
      },
      jobId: assessJob,
    },
    { supplierId: args.supplierId, programId: args.programId },
  );
  console.warn('  assess replayed (no spend) — the Shortlist now has a published Assessment');

  const category = await db.query.category.findFirst({
    where: eq(t.category.code, CATEGORY_CODE),
  });
  if (!category) throw new Error(`no seeded category "${CATEGORY_CODE}"`);

  const jobId = await openJob(db, args.runId, 'recommend', category.id);
  console.warn(`  recommending "${CATEGORY_CODE}" live — this spends tokens`);
  const result = await recommendCategory(
    {
      db,
      toolCtx: toolCtx(db, args.runId, jobId),
      modelCtx: { db, runId: args.runId, jobId, credentials: { apiKey: args.apiKey } },
      jobId,
    },
    { programId: args.programId, categoryId: category.id },
  );
  console.warn(`  version ${result.n} · ${result.evaluatorOutcome}`);
  return jobId;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

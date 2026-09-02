// Next.js loads `.env` itself; a plain Node entrypoint has to ask.
import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import * as t from '@/db/schema';
import { loadEnv } from '@/config/env';
import { assessSupplier } from '@/jobs/assess';
import { recommendCategory } from '@/jobs/recommend';
import { runResolveJob } from '@/jobs/resolve-job';
import { createUpstream } from '@/upstream';
import { seedTestProgram } from '@/db/seed-test-program';
import { TEST_PROGRAM } from '@/db/seed-data/test-program';
import { loadFixture } from '@/fixtures/load';
import { replayFetch } from '@/fixtures/replay-fetch';
import { replayUpstream } from '@/fixtures/replay-upstream';
import { fixtureDigest, recordFixture, serializeFixture } from '@/fixtures/record';
import { resetAnthropicClients } from '@/model/client';
import { closeTestDb, getTestDb, testDatabaseIsUp } from '../tests/support/test-db';
import { resetDerived } from '../tests/support/reset';
import { buildAssessableSupplier, openJob } from '../tests/support/pipeline';
import { seededProgram } from '../tests/support/seeded-program';

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
 * is a script rather than a test. For `assess` and `recommend`, Sayari costs
 * nothing: every upstream read is served from the fixtures the helper seeds.
 *
 * ## The four resolve recipes are different, and they spend Sayari credits
 *
 * A resolve Job's whole input **is** the upstream, so it cannot be served from
 * a fixture without recording a recording. Each one resets the test database
 * first and then runs the real Job against the live graph — see
 * `RESOLVE_RECIPES` for which roster row each records and why.
 */

const FIXTURE_DIR = join(process.cwd(), 'tests', 'fixtures');

/** The roster row every replay in this family is built around. */
const ROSTER_NAME = 'Yazaki';

/** The Category `recommend/one-category` argues over. */
const CATEGORY_CODE = 'HAR';

const RECIPES = {
  assess: 'assess/published-with-objections',
  recommend: 'recommend/one-category',
  'rules-r0': 'resolve/rules-r0',
  'agree-r1': 'resolve/agree-r1',
  'not-found': 'resolve/not-found',
  sanctioned: 'resolve/sanctioned',
} as const;

type Recipe = keyof typeof RECIPES;

/**
 * The four resolve recipes, and the roster row each one is recorded from.
 *
 * ## Why these four rows
 *
 * - **`rules-r0`** — the auto-accept gate settling **alone**: plain code, zero
 *   Rounds, zero model turns (SPEC §6.3). It was recorded from `Bosch`, which
 *   no longer clears the gate: `ROBERT BOSCH`, a second Sayari record carrying
 *   the name and almost nothing else, fails no Discriminator, and the gate now
 *   refuses a winner no rival has been ruled out against. `American Axle &
 *   Manufacturing` is the row where the gate's own change is the point — it
 *   used to settle on `American Axle & Manufacturing (Thailand) Co., Ltd.` and
 *   now settles on `AMERICAN AXLE & MANUFACTURING INC`.
 * - **`agree-r1`** — two agents independently naming one company. `Yazaki` is
 *   the row the assess and recommend fixtures are built on
 *   (`buildAssessableSupplier`), so it has to stay this one.
 * - **`not-found`** and **`sanctioned`** — the two arranged Suppliers of the
 *   test-only Program (SPEC §19.3, finding 79). Their outcomes are facts about
 *   the world: no company has the first name, and the second is on every major
 *   sanctions list.
 *
 * ## Recording from a truncate is not fussiness
 *
 * Finding 85: `resolve/sanctioned` replayed four turns and missed on the fifth
 * because the **recording** ran second, so the arranged Program already held
 * the other Supplier's Match, Candidates and Entities. The replay starts from
 * `resetDerived()` and its own fixture. Each recipe below resets first, so the
 * recording's starting state is trivially the replay's.
 */
const RESOLVE_RECIPES = {
  'rules-r0': { rosterName: 'American Axle & Manufacturing', arranged: false, agents: false },
  'agree-r1': { rosterName: 'Yazaki', arranged: false, agents: true },
  'not-found': {
    rosterName: 'Nordhavn Präzisionsteile Vertriebsgesellschaft',
    arranged: true,
    agents: true,
  },
  sanctioned: { rosterName: 'Rosoboronexport', arranged: true, agents: true },
} as const;

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
    const jobId = await record(db, recipe, env);

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
type Env = ReturnType<typeof loadEnv>;

/** Runs one recipe live and returns the Job to export. */
async function record(db: Db, recipe: Recipe, env: Env): Promise<string> {
  if (recipe === 'assess' || recipe === 'recommend') {
    // Exactly what the replay does, by calling exactly what the replay calls.
    await resetDerived(db);
    const { supplierId, programId, runId } = await buildAssessableSupplier(db, ROSTER_NAME);
    resetAnthropicClients();
    const args = { supplierId, programId, runId, apiKey: env.ANTHROPIC_API_KEY };
    return recipe === 'assess' ? recordAssess(db, args) : recordRecommend(db, args);
  }
  return recordResolve(db, recipe, env);
}

/**
 * Records one resolve Job **live** — live Sayari, and live Anthropic where the
 * recipe reaches the agents.
 *
 * Unlike the assess and recommend recipes, this one cannot serve its upstream
 * from a fixture: a resolve Job's whole input *is* the upstream, so replaying
 * it would record a recording. It costs Sayari credits, which is why it is a
 * script and not a test.
 *
 * `round` is supplied only where the recipe expects the agents to run. Withheld,
 * `resolveSupplier` parks whatever the gate could not settle — which is exactly
 * the state `rules-r0` records, and what makes its "zero model turns" claim
 * testable rather than merely asserted.
 */
async function recordResolve(
  db: Db,
  recipe: keyof typeof RESOLVE_RECIPES,
  env: Env,
): Promise<string> {
  const plan = RESOLVE_RECIPES[recipe];

  await resetDerived(db);
  if (plan.arranged) await seedTestProgram(db);
  resetAnthropicClients();

  const programId = plan.arranged ? TEST_PROGRAM.id : (await seededProgram(db)).id;
  const supplier = await db.query.supplier.findFirst({
    where: and(eq(t.supplier.programId, programId), eq(t.supplier.rosterName, plan.rosterName)),
  });
  if (!supplier) throw new Error(`no seeded supplier "${plan.rosterName}"`);

  const [run] = await db
    .insert(t.run)
    .values({
      programId,
      state: 'running',
      trigger: 'full',
      subjectLabel: RECIPES[recipe],
    })
    .returning({ id: t.run.id });
  const jobId = await openJob(db, run!.id, 'resolve', supplier.id);

  const upstream = createUpstream({
    db,
    runId: run!.id,
    jobId,
    credentials: {
      sayariClientId: env.SAYARI_CLIENT_ID,
      sayariClientSecret: env.SAYARI_CLIENT_SECRET,
      nominatimUserAgent: env.NOMINATIM_USER_AGENT,
    },
  });

  console.warn(
    `  resolving "${plan.rosterName}" live — this spends Sayari credits${plan.agents ? ' and Anthropic tokens' : ' and no Anthropic tokens'}`,
  );
  const outcome = await runResolveJob(
    {
      db,
      upstream,
      jobId,
      ...(plan.agents
        ? {
            round: {
              toolCtx: {
                db,
                upstream,
                meter: { addModelTokens: () => {} },
                runId: run!.id,
                jobId,
                surface: 'job' as const,
              },
              modelCtx: {
                db,
                runId: run!.id,
                jobId,
                credentials: { apiKey: env.ANTHROPIC_API_KEY },
              },
            },
          }
        : {}),
    },
    { supplierId: supplier.id },
  );
  console.warn(
    `  ${outcome.status} · settled by ${outcome.settledBy} · ${outcome.rounds} round(s) · ${outcome.entityId ?? 'no entity'}`,
  );
  console.warn(`  reason: ${outcome.reason}`);
  return jobId;
}

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

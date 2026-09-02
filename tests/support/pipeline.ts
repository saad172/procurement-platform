import * as t from '@/db/schema';
import { JOB_CAPS } from '@/config/constants';
import { runResolveJob } from '@/jobs/resolve-job';
import { enrichSupplier } from '@/jobs/enrich-supplier';
import { replayFetch } from '@/fixtures/replay-fetch';
import { loadFixture } from '@/fixtures/load';
import { replayUpstream, seedUpstream } from '@/fixtures/replay-upstream';
import type { TestDb } from './test-db';
import { seededProgram } from './seeded-program';

/**
 * Builds the state a later Job reads, by **running the earlier Jobs**.
 *
 * ## Why not snapshot the database instead
 *
 * `assess` and `recommend` read almost nothing from upstream — their inputs are
 * a Match, a resolved Entity, ten Enrichments and six Criterion values, all of
 * which earlier Jobs wrote. So their fixtures carry **zero upstream rows**, and
 * a replay against an empty database has nothing to assess.
 *
 * The obvious fix is to snapshot the derived tables into the fixture. It is the
 * wrong one: a snapshot is a *state*, and states go stale silently — a schema
 * change or a scoring change leaves the snapshot describing a database that can
 * no longer exist, and the replay keeps passing against it.
 *
 * Running the pipeline instead means the inputs are produced the way production
 * produces them, by the current code. When the scoring anchors move, the
 * Criterion values this builds move with them, and an assess fixture that no
 * longer matches its inputs **says so**.
 *
 * ## The cost, stated plainly
 *
 * It couples the fixtures: a change that forces `resolve/agree-r1` to be
 * re-recorded also breaks the assess replay until it is. That coupling is real,
 * and it is also true of the system — these Jobs *are* a pipeline, and a
 * fixture that pretended otherwise would be hiding it.
 *
 * Everything here is offline: recorded model turns, cached upstream bodies, no
 * credentials.
 */

export type PipelineResult = { supplierId: string; programId: string; runId: string };

/**
 * resolve → enrich, leaving a Supplier with a Match, a profile and its scores.
 *
 * `enrich` has no fixture of turns because it runs no model; what its fixture
 * carries is the ten upstream bodies the fan-out read.
 */
export async function buildAssessableSupplier(
  db: TestDb,
  rosterName: string,
): Promise<PipelineResult> {
  const program = await seededProgram(db);
  const supplier = await db.query.supplier.findFirst({
    where: (row, { eq }) => eq(row.rosterName, rosterName),
  });
  if (!program || !supplier) throw new Error(`no seeded supplier "${rosterName}"`);

  const resolveFixture = await loadFixture('resolve/agree-r1');
  const enrichFixture = await loadFixture('enrich/yazaki');
  await seedUpstream(db, resolveFixture);
  await seedUpstream(db, enrichFixture);

  const [run] = await db
    .insert(t.run)
    .values({ programId: program.id, state: 'running', trigger: 'full', subjectLabel: 'pipeline' })
    .returning({ id: t.run.id });

  const resolveJob = await openJob(db, run!.id, 'resolve', supplier.id);
  const upstream = replayUpstream(db, run!.id, resolveJob);
  await runResolveJob(
    {
      db,
      upstream,
      round: {
        toolCtx: {
          db,
          upstream,
          meter: { addModelTokens: () => {} },
          runId: run!.id,
          jobId: resolveJob,
          surface: 'job',
        },
        modelCtx: {
          db,
          runId: run!.id,
          jobId: resolveJob,
          credentials: { apiKey: 'not-a-key', fetch: replayFetch(resolveFixture) },
        },
      },
      jobId: resolveJob,
    },
    { supplierId: supplier.id },
  );

  const enrichJob = await openJob(db, run!.id, 'enrich', supplier.id);
  await enrichSupplier(
    {
      db,
      upstream: replayUpstream(db, run!.id, enrichJob),
      meter: { addModelTokens: () => {} },
      runId: run!.id,
      jobId: enrichJob,
    } as never,
    { supplierId: supplier.id, programId: program.id },
  );

  return { supplierId: supplier.id, programId: program.id, runId: run!.id };
}

/**
 * A **second** enrich Job over a Supplier the pipeline has already enriched.
 *
 * Re-enrichment is a normal act — a person clicks *Run* again, or a Deep
 * Traversal reopens a Profile — and it is the act every append-only Enrichment
 * table is exposed to. Everything upstream is served from the cache the first
 * pass warmed, so this spends nothing and asks the same questions.
 */
export async function reEnrichSupplier(
  db: TestDb,
  args: { supplierId: string; programId: string; runId: string },
): Promise<void> {
  const jobId = await openJob(db, args.runId, 'enrich', args.supplierId);
  await enrichSupplier(
    {
      db,
      upstream: replayUpstream(db, args.runId, jobId),
      meter: { addModelTokens: () => {} },
      runId: args.runId,
      jobId,
    } as never,
    { supplierId: args.supplierId, programId: args.programId },
  );
}

/**
 * A Job row, because caps and `job_id` are what the bookkeeping hangs off.
 *
 * The subject type is derived from the kind, because each kind is about exactly
 * one sort of thing: a Category for `recommend`, a **company** for `traverse`
 * and `fetch_entity` — a Deep Traversal is about an entity in the graph, and a
 * Twin or an owner is on nobody's roster — and a Supplier for the rest.
 */
export async function openJob(
  db: TestDb,
  runId: string,
  kind: keyof typeof JOB_CAPS,
  subjectId: string,
): Promise<string> {
  const [job] = await db
    .insert(t.job)
    .values({
      runId,
      kind,
      subjectType:
        kind === 'recommend'
          ? 'category'
          : kind === 'traverse' || kind === 'fetch_entity'
            ? 'entity'
            : 'supplier',
      subjectId,
      state: 'running',
      toolCallCap: JOB_CAPS[kind].toolCalls,
      tokenCap: JOB_CAPS[kind].tokens,
    })
    .returning({ id: t.job.id });
  return job!.id;
}

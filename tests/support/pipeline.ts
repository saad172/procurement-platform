import * as t from '@/db/schema';
import { JOB_CAPS } from '@/config/constants';
import { runResolveJob } from '@/jobs/resolve-job';
import { enrichSupplier } from '@/jobs/enrich-supplier';
import { replayFetch } from '@/fixtures/replay-fetch';
import { loadFixture } from '@/fixtures/load';
import { replayUpstream, seedUpstream } from '@/fixtures/replay-upstream';
import type { Fixture } from '@/fixtures/types';
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
  await seedRecordsFromFixture(db, resolveFixture);
  await seedRecordsFromFixture(db, enrichFixture);

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

/**
 * Seeds a `record` row for every source record the cached bodies name.
 *
 * ## The asymmetry this closes
 *
 * Only `sayari_get_record` writes to `record` (`tools/catalog/lookups.ts`), and
 * nothing in the reconstructed pipeline calls it — so the table is empty here,
 * while the development database a recording runs against has it warm from
 * every earlier Job. That difference is invisible until a model cites a source
 * record: `resolveCitations` looks the row up, finds nothing, and the citation
 * check rejects the whole draft.
 *
 * It is not hypothetical. `assess/published-with-objections` carries **eight**
 * `recordId` citations and its recording never called `sayari_get_record`, so
 * those rows can only have come from the development database's own history.
 * Re-recording that fixture against this starting state fails for exactly that
 * reason — twelve objections, every one of them *"points at a row that does not
 * exist"*. This is the residual half of finding 85: recording and replay must
 * not own different starting states, and `record` was the table still doing so.
 *
 * ## Deliberately partial rows
 *
 * The ids and their two dates are what the cached bodies genuinely carry. A
 * record's `source`, `label` and `fields` come only from `getRecord`, which
 * spends a Sayari credit — so they are left null rather than invented. That is
 * enough for a citation to resolve against evidence the recording really saw,
 * and it never puts made-up content behind one.
 */
export async function seedRecordsFromFixture(db: TestDb, fixture: Fixture): Promise<number> {
  const seen = new Map<string, { publishedAt: Date | null; collectedAt: Date | null }>();

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;

    // A record id rides under `record` on a relationship value and under
    // `referenceId` on an entity; both name the same id space, and a model can
    // cite either.
    for (const key of ['record', 'referenceId'] as const) {
      const id = obj[key];
      if (typeof id === 'string' && id.length > 0 && !seen.has(id)) {
        seen.set(id, {
          publishedAt: asDate(obj.publicationDate),
          collectedAt: asDate(obj.acquisitionDate),
        });
      }
    }

    for (const value of Object.values(obj)) walk(value);
  };

  for (const row of fixture.upstream) walk(row.body);
  if (seen.size === 0) return 0;

  await db
    .insert(t.record)
    .values(
      [...seen].map(([id, dates]) => ({
        id,
        publishedAt: dates.publishedAt,
        collectedAt: dates.collectedAt,
      })),
    )
    // A later fixture naming the same record must not overwrite the first, and
    // `first_seen_at` is what the staleness rule reads (SPEC §12.1).
    .onConflictDoNothing({ target: t.record.id });

  return seen.size;
}

/** A date the cached body carries, or null. Never throws on a malformed one. */
function asDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

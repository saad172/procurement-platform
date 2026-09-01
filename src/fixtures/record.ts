import { createHash } from 'node:crypto';
import { asc, eq, inArray } from 'drizzle-orm';
import * as t from '@/db/schema';
import type { Database } from '@/db/client';
import { buildManifest } from '@/model';
import type { LoopName } from '@/model/settings';
import type { Fixture, FixtureTurn, FixtureUpstreamRow } from './types';

/**
 * Exports one real Job's rows as a fixture (SPEC §19.1).
 *
 * **Nothing here is computed.** Every field is a column, copied. The moment
 * this file started reconstructing a request or synthesising a body, the output
 * would stop being a record of a run and become a hand-written fixture that
 * merely looks like one — and the replay-bar claim rests on the fixture being
 * an export, not a construction.
 *
 * The one exception is the manifest, and it is a *snapshot* rather than a
 * computation: `buildManifest()` is called and its answer stored, so a later
 * disagreement can only mean the code actually changed.
 */

export class UnrecordableJobError extends Error {
  constructor(jobId: string, reason: string) {
    super(`Job ${jobId} cannot be exported as a fixture: ${reason}`);
    this.name = 'UnrecordableJobError';
  }
}

/**
 * The spine. Reads top to bottom as the phases the fixture is assembled from:
 * the Job itself, its turns, the upstream bodies those turns and Job steps
 * read, then the manifest snapshot.
 */
export async function recordFixture(
  db: Database,
  args: { name: string; jobId: string; recordedAt: string },
): Promise<Fixture> {
  const job = await loadRecordableJob(db, args.jobId);

  const turnRows = await loadTurnRows(db, args.jobId, job.kind);
  const turns = toFixtureTurns(turnRows, args.jobId);

  const upstream = await loadFixtureUpstream(db, args.jobId);

  const { loopHashes, toolDigests } = buildLoopManifest(turnRows, turns);

  return {
    manifest: { name: args.name, recordedAt: args.recordedAt, loopHashes, toolDigests },
    turns,
    upstream,
  };
}

/**
 * `trace_fidelity` is the Job's own claim about whether it can drive a replay.
 * Exporting a `timeline` Job would produce a fixture that fails at the first
 * turn, which is a slower way of learning what the column already says.
 */
async function loadRecordableJob(db: Database, jobId: string) {
  const job = await db.query.job.findFirst({ where: eq(t.job.id, jobId) });
  if (!job) throw new UnrecordableJobError(jobId, 'no such job');
  if (job.traceFidelity !== 'replayable') {
    throw new UnrecordableJobError(jobId, `its trace_fidelity is "${job.traceFidelity}"`);
  }
  return job;
}

/**
 * A Job with **no turns** is recordable, and that is not a loophole.
 *
 * `enrich` runs no model at all — the fan-out is our code calling five
 * upstreams — so it has no turns by design, and refusing it would be refusing
 * a Job for behaving exactly as specified. What such a fixture carries is its
 * **upstream bodies**, which is precisely what a later Job's replay needs:
 * `assess` reads enrichments, and enrichments come from those bodies.
 *
 * The distinction that matters is *no turns* versus *turns we cannot replay*.
 * The second is still refused, below.
 */
async function loadTurnRows(
  db: Database,
  jobId: string,
  jobKind: Awaited<ReturnType<typeof loadRecordableJob>>['kind'],
) {
  const turnRows = await db
    .select()
    .from(t.traceTurn)
    .where(eq(t.traceTurn.jobId, jobId))
    .orderBy(asc(t.traceTurn.n));

  if (turnRows.length === 0 && jobKind !== 'enrich') {
    throw new UnrecordableJobError(
      jobId,
      `it has no trace turns, and "${jobKind}" is a model-driven kind that should have produced some`,
    );
  }

  return turnRows;
}

/** Maps `trace_turn` rows to the fixture's own shape, refusing any turn replay cannot key on. */
function toFixtureTurns(turnRows: Awaited<ReturnType<typeof loadTurnRows>>, jobId: string): FixtureTurn[] {
  const turns: FixtureTurn[] = turnRows.map((row) => {
    const request = row.request as {
      loop?: string;
      roundN?: number | null;
      wireHash?: string | null;
      bodyHash?: string | null;
    };
    return {
      n: row.n,
      wireHash: request.wireHash ?? null,
      bodyHash: request.bodyHash ?? null,
      loop: request.loop ?? 'unknown',
      roundN: request.roundN ?? null,
      // Stored verbatim as text; parsed here so the fixture holds JSON.
      response: JSON.parse(row.response) as unknown,
    };
  });

  const unhashable = turns.filter((turn) => turn.wireHash == null).map((turn) => turn.n);
  if (unhashable.length > 0) {
    throw new UnrecordableJobError(
      jobId,
      `turns ${unhashable.join(', ')} have no wire hash, so they could only be replayed by ` +
        'position. They were recorded before the capture existed — re-run the Job.',
    );
  }

  return turns;
}

/**
 * The upstream rows this Job actually read, found through its **usage rows** —
 * never "every row in the table".
 *
 * A fixture carrying rows its Job never touched would still replay, and would
 * still be wrong: the keyless wrapper's job is to throw on a lookup the
 * recording did not make, and a fixture stuffed with spare rows silently
 * answers lookups that should have been misses.
 *
 * **`usage_event`, not `trace_tool_call`.** The narrower table records calls a
 * *model* made, and the batch pre-pass is a **Job step, not a tool** (SPEC
 * §15.6) — one call carrying every roster row — so its body appears in no
 * `trace_tool_call` row at all. A fixture built from those alone throws a
 * cache miss on the first thing a resolve Job does.
 *
 * Every upstream call writes a `usage_event`, **including a cache hit**,
 * which matters more than it sounds: on the warm development cache where
 * fixtures are recorded, almost every read is a hit.
 */
async function loadFixtureUpstream(db: Database, jobId: string): Promise<FixtureUpstreamRow[]> {
  const usageRows = await db
    .select({ upstreamResponseId: t.usageEvent.upstreamResponseId })
    .from(t.usageEvent)
    .where(eq(t.usageEvent.jobId, jobId));

  const upstreamIds: string[] = [
    ...new Set(usageRows.map((row) => row.upstreamResponseId).filter((id): id is string => id != null)),
  ];

  // `inArray` with an empty list is a query with no legal shape, so the empty
  // case is answered without asking the database.
  const upstreamRows =
    upstreamIds.length === 0
      ? []
      : await db.select().from(t.upstreamResponse).where(inArray(t.upstreamResponse.id, upstreamIds));

  return upstreamRows.map((row) => ({
    source: row.source,
    endpoint: row.endpoint,
    paramsHash: row.paramsHash,
    params: row.params,
    body: row.body,
    bodyHash: row.bodyHash,
    via: row.via,
  }));
}

/**
 * Only the loops this fixture actually used.
 *
 * Pinning all six would redden this fixture when an unrelated loop's prompt
 * changed — a false alarm that trains people to re-record without reading,
 * which is the habit that makes a staleness test worthless.
 */
function buildLoopManifest(
  turnRows: Awaited<ReturnType<typeof loadTurnRows>>,
  turns: FixtureTurn[],
): { loopHashes: Record<string, string>; toolDigests: Record<string, string> } {
  const usedLoops = new Set(turns.map((turn) => turn.loop));
  const digests = digestsByLoop(turnRows);
  const loopHashes: Record<string, string> = {};
  const toolDigests: Record<string, string> = {};
  for (const entry of buildManifest(digests)) {
    if (!usedLoops.has(entry.loop)) continue;
    loopHashes[entry.loop] = entry.hash;
    toolDigests[entry.loop] = entry.toolDigestHash;
  }
  return { loopHashes, toolDigests };
}

/**
 * The tool digest **as recorded**, read off the turns rather than re-derived.
 *
 * A digest re-derived here would be today's tool list, so the manifest would
 * agree with itself no matter how far the tools had drifted since — a staleness
 * test that can never fail.
 */
function digestsByLoop(
  turnRows: { request: unknown; toolDigestHash: string | null }[],
): Partial<Record<LoopName, string>> {
  const digests: Partial<Record<LoopName, string>> = {};
  for (const row of turnRows) {
    const loop = (row.request as { loop?: string }).loop as LoopName | undefined;
    if (loop && row.toolDigestHash) digests[loop] = row.toolDigestHash;
  }
  return digests;
}

/** Stable, diffable JSON — a fixture is committed and reviewed like source. */
export function serializeFixture(fixture: Fixture): string {
  return `${JSON.stringify(fixture, null, 2)}\n`;
}

/** Names the fixture's content, so a re-record that changed nothing is visible. */
export function fixtureDigest(fixture: Fixture): string {
  return createHash('sha256')
    .update(JSON.stringify({ turns: fixture.turns, upstream: fixture.upstream }))
    .digest('hex');
}

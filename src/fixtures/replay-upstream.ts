import * as t from '@/db/schema';
import type { Database } from '@/db/client';
import { createUpstream } from '@/upstream';
import type { Fixture } from './types';

/**
 * The upstream half of a replay (SPEC §19.1).
 *
 * There is no fake wrapper here, and that is the point: replay uses **the same
 * `createUpstream`**, over the same `call()` chokepoint, with the same zod
 * projections — and simply omits the credentials. A wrapper built without them
 * cannot fall through to a live call, so it stops and names the key it missed.
 *
 * That absence is a *constructor argument*, not a mode flag. An
 * `UPSTREAM=live|cache` switch would be a second code path that CI exercises
 * and production does not, which is the shape this build refuses everywhere
 * else.
 */

/**
 * Loads a fixture's cached bodies into a database, so the keyless wrapper finds
 * exactly what the recording found — and misses on anything else.
 *
 * `upstream_response` is append-only with latest-wins on read, so re-seeding a
 * row the table already holds is harmless: the newest copy answers.
 */
export async function seedUpstream(db: Database, fixture: Fixture): Promise<number> {
  if (fixture.upstream.length === 0) return 0;

  await db.insert(t.upstreamResponse).values(
    fixture.upstream.map((row) => ({
      source: row.source as never,
      endpoint: row.endpoint,
      paramsHash: row.paramsHash,
      params: row.params as never,
      body: row.body as never,
      bodyHash: row.bodyHash,
      via: row.via as never,
    })),
  );
  return fixture.upstream.length;
}

/**
 * A wrapper that can only read what the fixture recorded.
 *
 * `refresh` is forced off. A replay that honoured a refresh request would ask
 * the network, and the whole guarantee here is that it cannot — better to
 * ignore the flag than to hand back a wrapper whose keylessness depends on
 * nobody setting it.
 */
export function replayUpstream(db: Database, runId: string, jobId?: string) {
  return createUpstream({
    db,
    runId,
    jobId,
    refresh: false,
    // No credentials. This is the whole mechanism.
  });
}

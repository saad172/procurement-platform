import { wireHash } from '@/model/wire';
import type { Fixture, FixtureTurn } from './types';

/**
 * `replayFetch` — the model seam (SPEC §19.1).
 *
 * ## There is no `ReplayModelClient`
 *
 * A hand-written `ModelClient` interface would wrap our own abstraction *around*
 * the Tool Runner, so the tests would exercise everything except the part
 * nobody has proved. This substitutes `fetch` instead, which means replay runs
 * **the real client and the real Tool Runner** — the same multi-turn loop, the
 * same tool dispatch, the same stop-reason handling — over recorded bodies.
 *
 * ## A miss throws, and says which turn
 *
 * Matching is by wire hash, so a changed system prompt, a changed tool schema,
 * a changed message ordering or a tool that now returns something different all
 * produce a miss on the first turn they affect. That is the point: a replay
 * that quietly served turn 2 by position would answer a question the code no
 * longer asks, and would stay green through exactly the changes it exists to
 * catch.
 *
 * The error names the missed turn and lists what the fixture holds, because the
 * useful question after a miss is always *which turn drifted, and from what*.
 *
 * ## And the count is readable, because a miss can look like a pass
 *
 * A miss is served to the SDK as a `400`, so what the *caller* sees is a loop
 * that failed to produce a submission — and for some Jobs that is a legal
 * outcome. `resolve/not-found` was green while throwing **eighteen** misses:
 * the assertions read `not_found` with no Candidates, which is exactly what a
 * Round that never got an answer produces, and exactly what the recording
 * itself had produced. The fixture was proving nothing and saying so to nobody.
 *
 * So the returned `fetch` carries its own bookkeeping — `misses` and `served` —
 * and a replay test asserts on it. That turns *"the outcome still looks right"*
 * into *"every recorded turn was served, in order, and none drifted"*, which is
 * the claim a fixture exists to make.
 */

export class ReplayMissError extends Error {
  constructor(
    readonly fixtureName: string,
    readonly attemptedHash: string,
    readonly served: number[],
    readonly available: FixtureTurn[],
  ) {
    const remaining = available.filter((turn) => !served.includes(turn.n));
    const next = remaining[0];
    super(
      [
        `Replay miss in fixture "${fixtureName}".`,
        `  The code sent a request hashing to ${attemptedHash.slice(0, 16)}…`,
        next
          ? `  The next unserved turn is n=${next.n} (${next.loop}${
              next.roundN == null ? '' : `, round ${next.roundN}`
            }), recorded at ${next.wireHash?.slice(0, 16) ?? 'no hash'}…`
          : `  Every one of the ${available.length} recorded turns has already been served.`,
        `  Turns served so far: ${served.length ? served.join(', ') : 'none'}.`,
        '',
        '  A miss means the request drifted from the one recorded — a changed prompt,',
        '  tool schema, message order, or tool result. Re-record with',
        `  \`pnpm fixtures:record ${fixtureName}\` once the change is intended.`,
      ].join('\n'),
    );
    this.name = 'ReplayMissError';
  }
}

/**
 * A turn recorded without a wire hash cannot be matched, only positioned.
 *
 * Rather than silently degrade to positional replay — which is the failure mode
 * this whole design avoids — the fixture is rejected at construction, where the
 * fix is obvious.
 */
export class UnhashableFixtureError extends Error {
  constructor(name: string, turns: number[]) {
    super(
      `Fixture "${name}" has ${turns.length} turn(s) with no wire hash (n=${turns.join(', ')}), ` +
        'so they can only be served by position, which cannot detect drift. Re-record it.',
    );
    this.name = 'UnhashableFixtureError';
  }
}

/**
 * Builds a `fetch` that serves a fixture's recorded responses.
 *
 * Each turn is served **at most once**. A loop that repeats a request it already
 * made is looping, and a replay that cheerfully served the same turn twice would
 * hide it.
 *
 * ## A miss is *returned*, not thrown
 *
 * Throwing from `fetch` is the obvious implementation and it is wrong here. The
 * SDK treats a thrown fetch as a transport failure: it wraps it as
 * `APIConnectionError: Connection error.` — discarding the message that named
 * the drifted turn — and then **retries it twice**, so the fixture is asked the
 * same impossible question three times before anyone sees a useless error.
 *
 * A `400` carries the message through the SDK's own error formatting and is not
 * retried, so the first miss is the one reported, and it says which turn.
 * `ReplayMissError` is still constructed — for its message, and for callers
 * that drive the fetch directly.
 */
/**
 * A `fetch` that also reports what it did.
 *
 * `misses` and `served` are getters over the closure's own counters, so a test
 * reads the live figure rather than a snapshot taken at construction.
 */
export type ReplayFetch = typeof fetch & {
  /** Requests that found no unserved turn with a matching wire hash. */
  readonly misses: number;
  /** The `n` of every turn served, in the order they were served. */
  readonly served: readonly number[];
};

export function replayFetch(fixture: Fixture): ReplayFetch {
  const unhashable = fixture.turns.filter((turn) => turn.wireHash == null).map((turn) => turn.n);
  if (unhashable.length > 0) throw new UnhashableFixtureError(fixture.manifest.name, unhashable);

  const byHash = new Map<string, FixtureTurn[]>();
  for (const turn of fixture.turns) {
    const bucket = byHash.get(turn.wireHash!) ?? [];
    bucket.push(turn);
    byHash.set(turn.wireHash!, bucket);
  }

  const served: number[] = [];
  let misses = 0;

  const fetchFixture: typeof fetch = async (_input, init) => {
    const body = init?.body;
    const hash = typeof body === 'string' ? wireHash(body) : '';

    const bucket = byHash.get(hash);
    const turn = bucket?.find((candidate) => !served.includes(candidate.n));
    if (!turn) {
      misses += 1;
      const miss = new ReplayMissError(fixture.manifest.name, hash, served, fixture.turns);
      return new Response(
        JSON.stringify({ type: 'error', error: { type: 'replay_miss', message: miss.message } }),
        {
          status: 400,
          headers: { 'content-type': 'application/json' },
        },
      );
    }
    served.push(turn.n);

    /**
     * A streamed turn is handed back as the **same SSE text that was
     * recorded**, not as a message the replay reassembles into events. The
     * client's own stream parsing is then part of what runs, which is the
     * point: a replay that rebuilt the event sequence would be testing the
     * rebuild.
     */
    if (turn.sse != null) {
      return new Response(turn.sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      });
    }

    return new Response(JSON.stringify(turn.response), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  return Object.defineProperties(fetchFixture, {
    misses: { get: () => misses, enumerable: true },
    served: { get: () => [...served], enumerable: true },
  }) as ReplayFetch;
}

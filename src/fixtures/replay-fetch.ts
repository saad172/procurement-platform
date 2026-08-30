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
export function replayFetch(fixture: Fixture): typeof fetch {
  const unhashable = fixture.turns.filter((turn) => turn.wireHash == null).map((turn) => turn.n);
  if (unhashable.length > 0) throw new UnhashableFixtureError(fixture.manifest.name, unhashable);

  const byHash = new Map<string, FixtureTurn[]>();
  for (const turn of fixture.turns) {
    const bucket = byHash.get(turn.wireHash!) ?? [];
    bucket.push(turn);
    byHash.set(turn.wireHash!, bucket);
  }

  const served: number[] = [];

  return async (_input, init) => {
    const body = init?.body;
    const hash = typeof body === 'string' ? wireHash(body) : '';

    const bucket = byHash.get(hash);
    const turn = bucket?.find((candidate) => !served.includes(candidate.n));
    if (!turn) {
      const miss = new ReplayMissError(fixture.manifest.name, hash, served, fixture.turns);
      return new Response(JSON.stringify({ type: 'error', error: { type: 'replay_miss', message: miss.message } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }
    served.push(turn.n);

    return new Response(JSON.stringify(turn.response), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

import { wireHash } from '@/model/wire';
import type { FixtureTurn } from './types';

/**
 * `recordingFetch` — how a fixture is captured for a loop that writes no Trace.
 *
 * ## Why this exists at all
 *
 * Six of the seven fixtures are exports of `trace_turn` rows, which is the
 * right mechanism precisely because those rows already exist: the Trace is the
 * record, and exporting it is what proves the Trace could drive a replay.
 *
 * **Chat has no Trace.** `thread_message.role` widens to
 * `user | assistant | tool`, which makes the transcript the complete record, so
 * `writeTurn` returns early when there is no `jobId`. There are no rows to
 * export, and inventing a Trace for chat purely to record a fixture would mean
 * carrying replay semantics on a surface that deliberately declines them — and
 * chat's context editing, which rewrites context mid-loop, is in tension with
 * replay anyway.
 *
 * So chat is recorded at the same seam it is replayed at. The symmetry is the
 * argument: `replayFetch` reads what `recordingFetch` wrote, at the same layer,
 * in the same units.
 *
 * ## It buffers, and says so
 *
 * A streamed response has to be read to be stored, so a clone is drained to
 * completion. That is a real cost and the reason this is not what production
 * uses — `capturing()` in `src/model/client.ts` skips streamed turns rather
 * than pay it for a number no `trace_turn` will hold.
 */

export type RecordingSink = {
  /** Turns in the order they were sent, ready to become a fixture. */
  turns: FixtureTurn[];
};

export function recordingFetch(
  inner: typeof fetch,
  sink: RecordingSink,
  meta: { loop: string; roundN?: number | null },
): typeof fetch {
  return async (input, init) => {
    const response = await inner(input, init);

    const body = init?.body;
    if (typeof body !== 'string') return response;

    const hash = wireHash(body);
    const n = sink.turns.length + 1;
    const contentType = response.headers.get('content-type') ?? '';

    /**
     * The clone is drained here rather than lazily, so the turn is on record
     * before the caller can consume the original and move on. Recording that
     * completes *after* the run has finished is a fixture with a race in it.
     */
    if (contentType.includes('text/event-stream')) {
      const sse = await response.clone().text();
      sink.turns.push({ n, wireHash: hash, loop: meta.loop, roundN: meta.roundN ?? null, response: null, sse });
    } else {
      const json = (await response.clone().json()) as unknown;
      sink.turns.push({ n, wireHash: hash, loop: meta.loop, roundN: meta.roundN ?? null, response: json });
    }

    return response;
  };
}

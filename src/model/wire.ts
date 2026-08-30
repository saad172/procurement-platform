import { createHash } from 'node:crypto';
import { canonicalJson } from '@/lib/canonical-json';

/**
 * The **wire hash** — a stable fingerprint of one outbound request body.
 *
 * ## Why the request has to be hashed at all
 *
 * SPEC §19.1 asks replay to drive the real Tool Runner, and to *throw* when a
 * request no longer matches the one recorded. Neither half is possible from
 * what `writeTurn` used to store: it stored the loop's *parameters* — model,
 * effort, system prompt — which describe the first turn and say nothing about
 * turns 2..n, whose bodies carry the accumulated messages and tool results.
 *
 * Replaying by ordinal instead ("hand back turn 1, then turn 2") would return a
 * recorded answer to a question the code no longer asks, which is the exact
 * failure a replay suite exists to catch. So the body itself is fingerprinted.
 *
 * ## Why only a hash is stored
 *
 * A whole request body is the entire conversation so far, repeated once per
 * turn — quadratic in the size of a Job, and the largest thing in the database
 * by a wide margin. The hash answers the only question replay asks of a
 * request: *is this the same one?* The response is stored whole, because replay
 * has to hand it back.
 *
 * ## Why `message.id` is the key
 *
 * The capture happens inside `fetch`, which sees a request and a response but
 * knows nothing about Jobs or turns; `writeTurn` knows the turn but never sees
 * the wire. The response body carries the message id, and so does the
 * `BetaMessage` the runner yields — so the id joins them without threading any
 * state through the Tool Runner, and it stays correct when several loops run at
 * once.
 */

/** Hashes an outbound request body, tolerating a body that is not JSON. */
export function wireHash(bodyText: string): string {
  let canonical: string;
  try {
    canonical = canonicalJson(JSON.parse(bodyText));
  } catch {
    canonical = bodyText;
  }
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Message id → wire hash, drained by `writeTurn`.
 *
 * Bounded, and dropped on read: an entry that is never claimed belongs to a
 * turn that failed before it was written, and a map that only grows is a leak
 * in a long-lived worker.
 */
const MAX_PENDING = 256;
const pending = new Map<string, string>();

export function rememberWireHash(messageId: string, hash: string): void {
  if (pending.size >= MAX_PENDING) {
    // Oldest first — insertion order is iteration order for a Map.
    const oldest = pending.keys().next();
    if (!oldest.done) pending.delete(oldest.value);
  }
  pending.set(messageId, hash);
}

export function takeWireHash(messageId: string): string | undefined {
  const hash = pending.get(messageId);
  pending.delete(messageId);
  return hash;
}

export function resetWireHashes(): void {
  pending.clear();
}

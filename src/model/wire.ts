import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

/**
 * A debugging affordance: set `MODEL_REQUEST_DUMP_DIR` and every outbound body
 * is written there as `<hash>.json`.
 *
 * It exists because a replay miss says *which turn* drifted and cannot say
 * *what in it* drifted — the fixture stores a hash, not a body, for good
 * reasons (a body is the whole conversation so far, repeated per turn). Dumping
 * both sides and diffing the two files is the only way to answer that question,
 * and it has now been the answer twice.
 *
 * Off unless the variable is set, and never on in normal running.
 */
const DUMP_DIR = process.env.MODEL_REQUEST_DUMP_DIR;

function dump(hash: string, bodyText: string): void {
  if (!DUMP_DIR) return;
  try {
    mkdirSync(DUMP_DIR, { recursive: true });
    writeFileSync(join(DUMP_DIR, `${hash}.json`), bodyText);
  } catch {
    // A debugging aid that can break a run is worse than no debugging aid.
  }
}

/**
 * Row ids, replaced by the order in which they first appear.
 *
 * ## Why the raw body cannot be hashed
 *
 * A prompt contains **database row ids**, and it has to: a Citation points at a
 * row, so the model is given `matchId`, `criterionValueIds`, `enrichmentId` and
 * the rest, or it cannot cite anything. Those ids come from
 * `gen_random_uuid()`, so they differ in every database — and a fixture whose
 * hash covers them can only ever replay against the database it was recorded
 * on.
 *
 * Making the seed deterministic fixed this for *authored* rows. Derived rows
 * are created as a run goes, and cannot be pinned the same way.
 *
 * So the hash is taken over a **database-independent projection** of the
 * request: each distinct uuid becomes `«id:N»`, numbered by first appearance.
 *
 * ## What that keeps, and what it gives up
 *
 * It stays sensitive to **how many** ids appear, **where** they appear, and
 * **the pattern of repetition** between them — so a prompt that cites three
 * rows where it cited two, or cites the same row twice where it cited two
 * different ones, still changes the hash.
 *
 * It is deliberately blind to **which** row an id names. Two requests that
 * differ only by pointing at a different row of the same kind, in the same
 * position, hash identically. That is a real loss, and it is the price of a
 * fixture that replays anywhere; the alternative is no assess or recommend
 * fixture at all, since every one of their prompts is full of ids.
 *
 * Only uuids are normalised. Sayari entity ids, LEIs, HS codes and every number
 * are hashed as they stand — those are *content*, and a change in them is
 * exactly the drift a replay must catch.
 */
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Row **instants**, normalised for the same reason as row ids.
 *
 * `get_supplier` returns the Match row, which carries `settled_at`; a Criterion
 * value carries when it was written. Those are wall-clock, so a replay — which
 * is time-shifted by construction — can never reproduce them.
 *
 * **Instants only, never dates.** The pattern requires a `T` and a time, so
 * `2026-06-16T14:02:11.481Z` is normalised and `2026-06-16` is not. That line
 * is where the meaning changes: in this domain a plain date is *content* — a
 * registration date, a latest shipment, a WGI vintage — and a change in one is
 * exactly the drift a replay must catch. A row's insert instant is bookkeeping.
 */
const INSTANT_ANYWHERE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;

/**
 * Replaces database-minted values with placeholders numbered by first
 * appearance, so the projection stays sensitive to *how many* and *where* while
 * being blind to the values themselves.
 */
export function normaliseRowIds(text: string): string {
  const seen = new Map<string, string>();
  const placeholder = (kind: string, raw: string): string => {
    const key = `${kind}:${raw.toLowerCase()}`;
    let existing = seen.get(key);
    if (!existing) {
      existing = `«${kind}:${seen.size}»`;
      seen.set(key, existing);
    }
    return existing;
  };

  // Instants first: a uuid can never contain one, but an instant is replaced
  // wholesale and must not have had its digits renumbered underneath it.
  return text
    .replace(INSTANT_ANYWHERE, (instant) => placeholder('ts', instant))
    .replace(UUID_ANYWHERE, (id) => placeholder('id', id));
}

/** Hashes an outbound request body, tolerating a body that is not JSON. */
export function wireHash(bodyText: string): string {
  let canonical: string;
  try {
    canonical = canonicalJson(JSON.parse(bodyText));
  } catch {
    canonical = bodyText;
  }
  const hash = createHash('sha256').update(normaliseRowIds(canonical)).digest('hex');
  dump(hash, bodyText);
  return hash;
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

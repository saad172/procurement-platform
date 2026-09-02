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

function dump(bodyText: string): void {
  if (!DUMP_DIR) return;
  try {
    mkdirSync(DUMP_DIR, { recursive: true });
    // Named by the **raw** hash, not the wire hash, so a dump keeps its
    // identity when the wire hash changes — see `rawBodyHash`.
    writeFileSync(join(DUMP_DIR, `${rawBodyHash(bodyText)}.json`), bodyText);
  } catch {
    // A debugging aid that can break a run is worse than no debugging aid.
  }
}

/**
 * The **stable** identity of a request body: sha256 of the bytes, normalised by
 * nothing.
 *
 * The wire hash exists to answer *"is this the same request?"* across
 * databases, so it changes whenever that judgement is refined — and it was
 * refined three times. Each refinement renamed every dump and broke
 * `fixtures:rehash`, which matched a fixture's stored hash against a dump's
 * filename: after one rehash the stored hashes were new and the filenames were
 * old, so the second rehash found nothing.
 *
 * A raw hash never changes, because it makes no judgement. Storing it beside
 * the wire hash gives the two a permanent link, and rehashing stays possible
 * however many times the wire hash is redefined.
 */
export function rawBodyHash(bodyText: string): string {
  return createHash('sha256').update(bodyText).digest('hex');
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
 * ## Collapsed to a constant, not numbered
 *
 * The first three versions numbered ids by first appearance, to stay sensitive
 * to *how many* appeared and to *the pattern of repetition* between them. That
 * sensitivity turned out to be unusable, and it produced **three false
 * mismatches**, each costing a full pipeline re-run:
 *
 * 1. instants and ids sharing one counter, so an extra instant shifted every id;
 * 2. `fetchedAt` and `firstSeenAt` coinciding in one run and not the other;
 * 3. the same `matchId` numbered `«id:1»` in a recording and `«id:11»` in its
 *    replay, because the count of distinct ids *earlier in the body* differed.
 *
 * The third is the one that settles it. Positional numbering is a claim about
 * every id that came before, so it turns any difference in id multiplicity
 * anywhere into a mismatch everywhere after it — and id multiplicity in a
 * prompt is an artifact of which rows a database happened to mint, which is the
 * exact thing this projection exists to ignore.
 *
 * So every uuid becomes `«id»`, exactly like an instant.
 *
 * ## What that gives up, stated plainly
 *
 * Sensitivity to **which** row an id names, to **how many** distinct rows
 * appear, and to **whether the same row is cited twice**. A request that cited
 * two rows where it cited one now hashes the same.
 *
 * That is a genuine loss of fidelity, and it is bounded by what the fixture
 * still holds: the **response is stored verbatim**, so what the model actually
 * cited is on record and the assertions read it from the published rows. What
 * the hash still catches is everything that is not a row id — a changed
 * prompt, a changed tool schema, a changed tool result, a changed message
 * order.
 *
 * Only uuids and instants are normalised. Sayari entity ids, LEIs, HS codes and
 * every number are hashed as they stand — those are *content*, and a change in
 * them is exactly the drift a replay must catch.
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
  // Instants first: a uuid can never contain one, but an instant is replaced
  // wholesale and must not have had its digits renumbered underneath it.
  return text.replace(INSTANT_ANYWHERE, '«ts»').replace(UUID_ANYWHERE, '«id»');
}

/**
 * Cache markers, dropped at every depth.
 *
 * ## Why a marker is not content
 *
 * `cache_control` says nothing about what was asked. It is a hint about how the
 * transport should treat a prefix — the same question, with a note about where
 * to break for caching — and the answer it draws is identical either way. The
 * wire hash exists to answer *"is this the same request?"*, and by that
 * question a marked and an unmarked body are the same request.
 *
 * The alternative was measured and rejected: switching prompt caching on
 * changes the bytes of every outbound body, so every fixture in the suite would
 * have gone red at turn 1 and been re-recorded — spending a full pipeline's
 * tokens to record answers to questions that had not changed. **A fixture
 * re-recorded for a reason that is not drift is a fixture that has stopped
 * proving anything.**
 *
 * What is given up is sensitivity to *where the breakpoints are*, which is a
 * genuine loss and a bounded one: `rawBodyHash` is stored beside the wire hash
 * on every turn and is taken over the bytes as sent, so a recording still shows
 * the markers were present, and `MODEL_REQUEST_DUMP_DIR` still dumps the body
 * verbatim. The layout itself is asserted directly, in `caching.test.ts`, over
 * the request `buildRunner` produces.
 *
 * This is the **fourth** refinement of what "the same request" means, and each
 * one is why `rawBodyHash` exists: a recovery mechanism keyed on the thing it
 * recovers from breaks on its second use.
 */
function withoutCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCacheControl);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== 'cache_control')
        .map(([key, nested]) => [key, withoutCacheControl(nested)]),
    );
  }
  return value;
}

/** Hashes an outbound request body, tolerating a body that is not JSON. */
export function wireHash(bodyText: string): string {
  let canonical: string;
  try {
    canonical = canonicalJson(withoutCacheControl(JSON.parse(bodyText)));
  } catch {
    canonical = bodyText;
  }
  dump(bodyText);
  return createHash('sha256').update(normaliseRowIds(canonical)).digest('hex');
}

/**
 * Message id → wire hash, drained by `writeTurn`.
 *
 * Bounded, and dropped on read: an entry that is never claimed belongs to a
 * turn that failed before it was written, and a map that only grows is a leak
 * in a long-lived worker.
 */
const MAX_PENDING = 256;
const pending = new Map<string, { wire: string; raw: string }>();

export function rememberWireHash(messageId: string, hash: { wire: string; raw: string }): void {
  if (pending.size >= MAX_PENDING) {
    // Oldest first — insertion order is iteration order for a Map.
    const oldest = pending.keys().next();
    if (!oldest.done) pending.delete(oldest.value);
  }
  pending.set(messageId, hash);
}

export function takeWireHash(messageId: string): { wire: string; raw: string } | undefined {
  const hash = pending.get(messageId);
  pending.delete(messageId);
  return hash;
}

export function resetWireHashes(): void {
  pending.clear();
}

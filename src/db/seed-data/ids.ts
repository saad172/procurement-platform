import { createHash } from 'node:crypto';

/**
 * Deterministic ids for seeded rows.
 *
 * ## Why the seed cannot mint random ids
 *
 * The seed is already idempotent, keyed on natural keys — the Program's name, a
 * Plant's code, a Category's code, a Supplier's roster index. But
 * `defaultRandom()` still gave every database its **own** ids, so two databases
 * seeded from the same file agreed on every column except the one everything
 * else points at.
 *
 * That is invisible until something has to travel between databases. A replay
 * fixture is exactly that: the recorded request carries the Program's id in its
 * page block, so a fixture recorded on the development database missed on turn
 * 1 against the test database — before any tool had run, on a prompt that had
 * not changed. The error said "the request drifted", which was true and
 * useless.
 *
 * So an id is now a **function of the natural key that already identified the
 * row**. The same seed produces the same ids on every machine, a fixture is
 * portable, and re-seeding cannot silently renumber anything that a derived row
 * already points at.
 *
 * ## Why UUIDv5 rather than a counter
 *
 * The columns are `uuid`, and a counter would need a mapping table to become
 * one. A name-based UUID *is* the mapping: it needs no state, no ordering, and
 * no coordination between the eight seed functions that call it.
 */

/** The namespace, so ids from this app cannot collide with any other. */
const NAMESPACE = 'procurement-platform:seed';

/**
 * A UUIDv5-shaped id derived from `kind` and `key`.
 *
 * sha256 rather than the sha1 RFC 4122 specifies, truncated to 16 bytes. The
 * version and variant bits are still set correctly, so Postgres, Drizzle and
 * every tool that parses a UUID sees a well-formed one — the hash underneath is
 * an implementation detail of *this* namespace, which no other system derives.
 */
export function seedId(kind: string, key: string): string {
  const bytes = createHash('sha256').update(`${NAMESPACE}:${kind}:${key}`).digest().subarray(0, 16);

  // Version 5 in the high nibble of byte 6; RFC 4122 variant in byte 8.
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/**
 * The instant every seeded row records as its `created_at`.
 *
 * **"When you happened to run the seed" is not a fact about the Programme.**
 * These rows are authored fixture data; their creation time is as authored as
 * their name, and letting it default to `now()` made two databases seeded from
 * the same file disagree on a value that then rode into a tool result and out
 * to the model.
 *
 * That is how it was found: a chat fixture recorded on one database replayed on
 * another and missed on turn 3 — not turn 1, because the divergence only
 * appeared once a tool had returned a row. The id fix above had already made
 * turn 1 match, which made the remaining difference easy to mistake for a
 * prompt change.
 *
 * Derived rows keep `now()`. An enrichment's `fetched_at` genuinely is when it
 * was fetched, and the staleness badge reads it.
 */
export const SEED_CREATED_AT = new Date('2026-01-05T00:00:00.000Z');

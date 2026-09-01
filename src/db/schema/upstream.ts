import { relations } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { upstreamSource, upstreamVia } from './enums';

/**
 * The upstream layer (SPEC §3.2, §16).
 *
 * `upstream_response` is the cache that makes a re-run cost tokens rather than
 * credits, and the row a replayed test reads instead of the network.
 *
 * `usage_event` — the single home of "what did this cost" — deliberately lives
 * in `runs.ts` instead. It references `run`, `job` and `trace_turn`, all of
 * which are defined there, and SPEC §5.1's claim that **every amount the app
 * spends sits inside exactly one Run, with no orphan path** is only true if
 * those are real foreign keys rather than loose uuid columns. Putting the table
 * beside its parents is what lets them be.
 */

/**
 * One row per outbound response body, keyed `(source, endpoint, params_hash)`.
 *
 * **Append-only, no TTL, latest-wins on read** (SPEC §3.2). Append-only rather
 * than upsert because a refresh would move a body that a Trace and a Citation
 * both point at — the stored evidence for a published sentence must not change
 * underneath it.
 *
 * `params_hash` is over canonical JSON of `{endpoint, params-after-defaults}`
 * with keys sorted. Defaults are applied *before* hashing, so changing a
 * default is a deliberate cache miss rather than an invisible one.
 */
export const upstreamResponse = pgTable(
  'upstream_response',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    source: upstreamSource('source').notNull(),
    endpoint: text('endpoint').notNull(),
    paramsHash: text('params_hash').notNull(),
    /** The canonical params the hash was taken over, so a miss can name them. */
    params: jsonb('params').notNull(),
    body: jsonb('body').notNull(),
    bodyHash: text('body_hash').notNull(),
    via: upstreamVia('via').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Latest-wins on read: the lookup is (source, endpoint, params_hash) ordered
    // by fetched_at desc, so this index is the read path, not a constraint.
    index('upstream_response_key_idx').on(t.source, t.endpoint, t.paramsHash, t.fetchedAt),
  ],
);

export const upstreamResponseRelations = relations(upstreamResponse, () => ({}));

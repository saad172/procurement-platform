import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { upstreamErrorKind, upstreamSource, upstreamVia, usageOutcome } from './enums';

/**
 * The upstream layer (SPEC §3.2, §16).
 *
 * `upstream_response` is the cache that makes a re-run cost tokens rather than
 * credits, and the row a replayed test reads instead of the network.
 * `usage_event` is the single home of "what did this cost".
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
export const upstreamResponse = pgTable('upstream_response', {
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
}, (t) => [
  // Latest-wins on read: the lookup is (source, endpoint, params_hash) ordered
  // by fetched_at desc, so this index is the read path, not a constraint.
  index('upstream_response_key_idx').on(t.source, t.endpoint, t.paramsHash, t.fetchedAt),
]);

/**
 * One row per **outbound attempt** (SPEC §3.2, §16.2).
 *
 * Attempt, not call: `maxRetries: 0` is set on the Sayari SDK precisely so that
 * one outbound attempt is one counted row. An SDK-internal retry would have
 * made one `usage_event` cover three requests.
 *
 * Model rows live here too — usage has one home, not two. Deriving spend from
 * `trace_turn` would be blind to chat, which has no Trace (SPEC §3.7).
 */
export const usageEvent = pgTable('usage_event', {
  id: uuid('id').primaryKey().defaultRandom(),

  /** Every amount the app spends belongs to exactly one Run (SPEC §5.1). */
  runId: uuid('run_id').notNull(),
  /** Null for a chat turn, which spends inside a Run but outside any Job. */
  jobId: uuid('job_id'),

  /** `sayari` | `gleif` | … for upstream rows; null for model rows. */
  source: upstreamSource('source'),
  endpoint: text('endpoint').notNull(),
  /** Sayari's own endpoint-class bucket, for reconciling against `getUsage()`. */
  bucket: text('bucket'),
  via: upstreamVia('via'),

  ms: integer('ms').notNull(),
  outcome: usageOutcome('outcome').notNull(),
  errorKind: upstreamErrorKind('error_kind'),
  /** A cache hit costs no credit; the confirm gate reads this to say so. */
  cacheHit: boolean('cache_hit').notNull().default(false),

  // ── Model rows only ──
  /**
   * Keyed by model id though we only ever ask for one, because server-side
   * refusal fallback can serve a turn from a model we did not choose
   * (SPEC §17.5).
   */
  model: text('model'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  cacheCreationInputTokens: integer('cache_creation_input_tokens'),
  cacheReadInputTokens: integer('cache_read_input_tokens'),
  /** Ties a model row to the turn it paid for. Null for upstream rows. */
  traceTurnId: uuid('trace_turn_id'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('usage_event_run_idx').on(t.runId),
  index('usage_event_job_idx').on(t.jobId),
]);

export const upstreamResponseRelations = relations(upstreamResponse, () => ({}));

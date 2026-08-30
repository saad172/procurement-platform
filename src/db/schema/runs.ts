import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { program } from './authored';
import {
  jobKind,
  jobState,
  jobSubjectType,
  runState,
  traceFidelity,
  upstreamErrorKind,
  upstreamSource,
  upstreamVia,
  usageOutcome,
} from './enums';
import { upstreamResponse } from './upstream';

/**
 * Runs, Jobs and the Trace (SPEC §3.7, §5, §18).
 *
 * **Every amount the app spends sits inside exactly one Run, with no orphan
 * path.** That is why settling a parked Supplier, a Deep Traversal, a
 * re-assessment and a re-run each start a Run of their own, and why a Thread's
 * first *model* turn lazily opens one — at the knowingly-accepted cost of a
 * longer Runs list.
 */

/** One click of *Run* and everything it set going (CONTEXT.md, *Run*). */
export const run = pgTable('run', {
  id: uuid('id').primaryKey().defaultRandom(),
  programId: uuid('program_id')
    .notNull()
    .references(() => program.id, { onDelete: 'cascade' }),
  state: runState('state').notNull().default('queued'),
  /** What this Run was for: `full`, `settlement`, `traverse`, `reassess`, `thread`… */
  trigger: text('trigger').notNull(),
  /** The subject a targeted Run was labelled with, so the Runs list reads well. */
  subjectLabel: text('subject_label'),

  /**
   * $3.00 × N Suppliers. A **soft ceiling with bounded overshoot**: it is
   * checked before dequeuing a Job and at each Round boundary inside one, and
   * concurrency 4 *is* the overshoot. Raisable — it is a spending decision a
   * person may revise, unlike a per-Job ceiling (SPEC §18.2).
   *
   * Null for a Thread's Run: a Thread has no N, and the confirm gate is the
   * bound instead — and it is the stronger one.
   */
  budgetUsd: numeric('budget_usd', { precision: 10, scale: 4 }),
  supplierCount: integer('supplier_count'),

  /** For the Run page's "up to $30 · actual $21.40". Written back to nothing. */
  estimateUsd: numeric('estimate_usd', { precision: 10, scale: 4 }),

  threadId: uuid('thread_id'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('run_program_idx').on(t.programId, t.createdAt)]);

/**
 * One unit of background work inside a Run.
 *
 * Its own caps **terminate** it; the Run's budget is what **pauses** it. That
 * distinction is the whole of SPEC §18.2 and it is why `state` carries both
 * `terminated` and `paused_on_budget` as separate values.
 */
export const job = pgTable('job', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id')
    .notNull()
    .references(() => run.id, { onDelete: 'cascade' }),
  kind: jobKind('kind').notNull(),
  subjectType: jobSubjectType('subject_type').notNull(),
  subjectId: text('subject_id').notNull(),
  state: jobState('state').notNull().default('queued'),

  /** Sized so that a cap firing on a healthy run is a bug (SPEC §18.3). */
  toolCallCap: integer('tool_call_cap').notNull(),
  tokenCap: integer('token_cap').notNull(),
  toolCallsUsed: integer('tool_calls_used').notNull().default(0),
  tokensUsed: integer('tokens_used').notNull().default(0),

  /**
   * `replayable` for everything our process drives; `timeline` for a Dossier,
   * whose context Managed Agents rewrites server-side (SPEC §17.2).
   */
  traceFidelity: traceFidelity('trace_fidelity').notNull().default('replayable'),

  /** Set when a cap stopped it, so the amber sentence can name the ceiling. */
  terminatedReason: text('terminated_reason'),
  /** Set when something broke, so the red sentence can name the error. */
  error: text('error'),

  attempt: integer('attempt').notNull().default(0),
  lockedAt: timestamp('locked_at', { withTimezone: true }),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // The dequeue path: oldest queued job first, taken with FOR UPDATE SKIP LOCKED.
  index('job_dequeue_idx').on(t.state, t.createdAt),
  index('job_run_idx').on(t.runId),
  index('job_subject_idx').on(t.subjectType, t.subjectId),
]);

/**
 * The resume checkpoint (SPEC §5.3).
 *
 * Agentic Jobs checkpoint at **Round boundaries**: completed Rounds survive a
 * killed worker and the in-flight Round restarts. Mid-loop message-array
 * rehydration was rejected — orphaned `tool_use` blocks and half-written tool
 * results are a bug class not worth the tokens saved, and the upstream cache
 * means a replayed Round costs tokens, not credits.
 *
 * The Round boundary is also the prompt-cache breakpoint, so the cache
 * breakpoint and the resume checkpoint are the same line (SPEC §17.4).
 */
export const jobRound = pgTable('job_round', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id')
    .notNull()
    .references(() => job.id, { onDelete: 'cascade' }),
  n: integer('n').notNull(),
  /** Enough to restart from here: the message array as it stood at the boundary. */
  checkpoint: jsonb('checkpoint').notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('job_round_job_n_key').on(t.jobId, t.n)]);

/**
 * One model turn.
 *
 * `response` stores **the whole `BetaMessage` verbatim** (SPEC §3.7, §19.1).
 * Not a projection: replay drives the real Tool Runner through a `replayFetch`,
 * and a projection would force replay to *synthesise* a body — which is a
 * hand-edited fixture wearing a different hat.
 *
 * Usage lives on `usage_event`, not here. One number, one home.
 */
export const traceTurn = pgTable('trace_turn', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id')
    .notNull()
    .references(() => job.id, { onDelete: 'cascade' }),
  n: integer('n').notNull(),
  request: jsonb('request').notNull(),
  response: jsonb('response').notNull(),
  stopReason: text('stop_reason'),
  /** Populated only on a refusal, so a whole-chain refusal is legible. */
  stopDetails: jsonb('stop_details'),
  /**
   * The tool names (legible to a human reading a Trace) and a hash of names,
   * input schemas and descriptions (comparable by a test). A hash mismatch is a
   * **warning**: a changed tool schema is exactly the drift that leaves a
   * fixture stale while it still passes (SPEC §15.7).
   */
  toolNames: jsonb('tool_names'),
  toolDigestHash: text('tool_digest_hash'),
  ms: integer('ms').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('trace_turn_job_n_key').on(t.jobId, t.n)]);

/**
 * One tool call inside a turn.
 *
 * The output is stored either inline or as a **pointer plus body hash** into
 * `upstream_response` — a raw Sayari payload is large, it is already stored
 * once, and storing it twice would make the Trace the biggest table in the
 * database for no gain.
 */
export const traceToolCall = pgTable('trace_tool_call', {
  id: uuid('id').primaryKey().defaultRandom(),
  traceTurnId: uuid('trace_turn_id')
    .notNull()
    .references(() => traceTurn.id, { onDelete: 'cascade' }),
  toolUseId: text('tool_use_id').notNull(),
  toolName: text('tool_name').notNull(),
  input: jsonb('input').notNull(),
  output: jsonb('output'),
  upstreamResponseId: uuid('upstream_response_id').references(() => upstreamResponse.id),
  bodyHash: text('body_hash'),
  ms: integer('ms').notNull(),
  ok: jsonb('ok'),
}, (t) => [index('trace_tool_call_turn_idx').on(t.traceTurnId)]);

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

  /**
   * Every amount the app spends belongs to exactly one Run (SPEC §5.1). The
   * foreign key is what makes that a guarantee rather than a convention.
   */
  runId: uuid('run_id')
    .notNull()
    .references(() => run.id, { onDelete: 'cascade' }),
  /** Null for a chat turn, which spends inside a Run but outside any Job. */
  jobId: uuid('job_id').references(() => job.id, { onDelete: 'cascade' }),

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

  /**
   * The cached body this call read or wrote — **the only complete link between
   * a Run and the upstream rows it touched.**
   *
   * `trace_tool_call` also points at `upstream_response`, and that link is the
   * narrower one on purpose: it records calls a *model* made. The batch
   * pre-pass is a **Job step, not a tool** (SPEC §15.6) — one call carrying
   * every roster row — so it makes an upstream call that no `trace_tool_call`
   * row will ever describe, and a replay fixture that missed it would throw a
   * cache miss on the first thing the Job did.
   *
   * Every upstream call writes a `usage_event`, including a cache hit, which is
   * why the link belongs here as well. Null on model rows, and on a call that
   * failed before a body existed.
   */
  upstreamResponseId: uuid('upstream_response_id').references(() => upstreamResponse.id, {
    onDelete: 'set null',
  }),

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
  traceTurnId: uuid('trace_turn_id').references(() => traceTurn.id, { onDelete: 'set null' }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('usage_event_run_idx').on(t.runId),
  index('usage_event_job_idx').on(t.jobId),
]);


export const runRelations = relations(run, ({ one, many }) => ({
  program: one(program, { fields: [run.programId], references: [program.id] }),
  jobs: many(job),
}));

export const jobRelations = relations(job, ({ one, many }) => ({
  run: one(run, { fields: [job.runId], references: [run.id] }),
  rounds: many(jobRound),
  turns: many(traceTurn),
}));

export const traceTurnRelations = relations(traceTurn, ({ one, many }) => ({
  job: one(job, { fields: [traceTurn.jobId], references: [job.id] }),
  toolCalls: many(traceToolCall),
}));

export const jobRoundRelations = relations(jobRound, ({ one }) => ({
  job: one(job, { fields: [jobRound.jobId], references: [job.id] }),
}));

export const traceToolCallRelations = relations(traceToolCall, ({ one }) => ({
  turn: one(traceTurn, { fields: [traceToolCall.traceTurnId], references: [traceTurn.id] }),
}));

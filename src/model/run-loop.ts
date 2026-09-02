import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta';
import type { BetaMessageStream } from '@anthropic-ai/sdk/lib/BetaMessageStream';
import { eq, sql } from 'drizzle-orm';
import * as t from '@/db/schema';
/**
 * The two counter functions live in `src/jobs/runs.ts` because **the `job`
 * table has one owner** — an ESLint rule refuses a write to it from anywhere
 * else, after the UI turned out to be a second owner of the Job state machine.
 * The chokepoint reads its ceiling from that owner rather than growing a second
 * writer of the same two columns.
 */
import { jobCountersSoFar, recordJobCounters } from '@/jobs/runs';
import { CACHE_CONTROL } from './caching';
import { getAnthropicClient } from './client';
import { describeModelError } from './describe-model-error';
import { takeFatalToolError } from './tool-adapter';
import { takeWireHash } from './wire';
import {
  BASE_BETAS,
  CONTEXT_EDITING_BETA,
  CONTEXT_MANAGEMENT,
  LOOP_SETTINGS,
  MAX_ITERATIONS_BACKSTOP,
  MAX_TOKENS,
  THINKING,
} from './settings';
import type { ModelContext, RunLoopOutcome, RunLoopParams } from './types';

/**
 * **The model chokepoint** (SPEC §2.4, §17.2).
 *
 * Sibling to `src/upstream/call()`, and the two places it deliberately diverges
 * from that one are documented where they occur rather than here.
 *
 * **The order of work is the design:**
 *
 *     yield → write trace_turn + usage_event → check caps → let the tools run
 *
 * Writing before checking is why a crash inside a tool still leaves the turn
 * that caused it on record. Checking before the tools run is why a Job that has
 * already breached its ceiling does not spend one more tool call proving it.
 */

/**
 * The tokens **the cap counts**, which is not the tokens the bill counts.
 *
 * `cache_read_input_tokens` is deliberately excluded. A per-Job ceiling is a
 * correctness backstop on how much work a Job does, and a cached read is work
 * the Job is *not* redoing — counting it would make the ceiling fire earlier on
 * the Jobs that cache best, which is the opposite of what it is for. Dollars
 * are a separate question with a separate function (`src/lib/price.ts`), and
 * that one counts every token, cached or not.
 */
function tokensOf(message: BetaMessage): number {
  const u = message.usage;
  return (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
}

/** Counts `tool_use` blocks, which is what the ceiling actually bounds. */
function toolCallsIn(message: BetaMessage): number {
  return message.content.filter((block) => block.type === 'tool_use').length;
}

/**
 * One yielded turn, resolved to a finished `BetaMessage`.
 *
 * The runner yields a `BetaMessage` when `stream` is off and a
 * `BetaMessageStream` when it is on. Normalising here rather than branching the
 * whole loop is what keeps a single statement of the order of work — write,
 * then check, then let the tools run — instead of two copies that can drift.
 *
 * Text deltas are forwarded as they arrive; if no one is listening, the stream
 * is simply awaited, which is exactly the non-streaming behaviour.
 */
async function resolveTurn(
  yielded: BetaMessage | BetaMessageStream,
  onTextDelta: ((text: string) => void) | undefined,
): Promise<BetaMessage> {
  if (!isMessageStream(yielded)) return yielded;
  if (onTextDelta) yielded.on('text', onTextDelta);
  return yielded.finalMessage();
}

/**
 * Told apart by `finalMessage`, not by `instanceof`.
 *
 * The class is reachable only through a deep subpath import, and a type guard
 * that depends on which copy of the SDK a bundler resolved is a guard that
 * fails silently in exactly one environment.
 */
function isMessageStream(value: BetaMessage | BetaMessageStream): value is BetaMessageStream {
  return typeof (value as BetaMessageStream).finalMessage === 'function';
}

/**
 * The spine. Reads top to bottom as the phases named above: yield (via
 * `resolveTurn`, already a private helper before this one) → write → check
 * caps → let the tools run. "Let the tools run" is never a call of its own —
 * it is what happens when a turn does not return: control falls back to
 * `for await`, and the SDK's tool runner executes any pending tool calls
 * before yielding the next turn.
 */
export async function runLoop(params: RunLoopParams, ctx: ModelContext): Promise<RunLoopOutcome> {
  /**
   * **The ceilings are per JOB, and a Job calls this up to twelve times.**
   *
   * Both counters therefore start from what the Job has already spent, read
   * back from `usage_event` and `trace_tool_call`. Starting them at zero made
   * `JOB_CAPS` a per-call ceiling while SPEC §17.6 and §18.3 both describe a
   * per-Job one — a recommend Job crossed its 900,000-token cap by half a
   * percent and nothing fired, because no single Round crossed it alone.
   *
   * Chat has no `jobId` and keeps counting per call, which is the right answer
   * there: chat is not a Job, has no Round boundary and no resume checkpoint,
   * and `CHAT_TOOL_CALL_CAP` is a runaway backstop on one turn.
   */
  const seed = ctx.jobId ? await jobCountersSoFar(ctx.db, ctx.jobId) : { toolCalls: 0, tokens: 0 };

  const { runner, controller } = buildRunner(params, ctx);

  let turns = 0;
  let toolCalls = seed.toolCalls;
  let tokens = seed.tokens;
  let lastMessage: BetaMessage | undefined;
  const toolUses: { name: string; input: unknown }[] = [];

  try {
    for await (const message of runner) {
      /**
       * Streaming turns arrive as a `BetaMessageStream`. Text deltas are handed
       * to `onTextDelta` as they land — that is the whole point of streaming —
       * and then the turn is awaited to completion.
       *
       * **The bookkeeping still runs on the finished message.** Metering a
       * partial turn would mean a `usage_event` whose token counts are not yet
       * known, and a cap check against a number still moving. Streaming changes
       * when the *person* sees the answer, not when the ledger is written.
       */
      const turn = await resolveTurn(message, params.onTextDelta);
      turns += 1;
      lastMessage = turn;

      const written = await recordTurn(ctx, params, turn);
      toolUses.push(...written.toolUses);
      toolCalls += written.toolCalls;
      tokens += written.tokens;

      // The Job's own ledger, brought up to date before anything can stop the
      // loop — so a Job killed mid-Round still says what it had spent.
      if (ctx.jobId) await recordJobCounters(ctx.db, ctx.jobId, { toolCalls, tokens });

      const decision = await checkCapsAndBudget(params, ctx, controller, turn, {
        turns,
        toolCalls,
        tokens,
        toolUses,
      });
      if (decision) return decision;
    }
  } catch (error) {
    if (controller.signal.aborted) {
      // An abort we initiated has already returned its outcome above; reaching
      // here means the abort raced the iterator, so report what we counted.
      return {
        status: 'terminated',
        reason: 'aborted at a ceiling',
        turns,
        toolCalls,
        tokens,
        toolUses,
      };
    }
    // Named loudly: a failure here is something only we can fix, and a silent
    // one reads to the caller as the model mis-shaping its output.
    console.error(`[model] runLoop(${params.loop}) failed:`, error);
    return { status: 'failed', error: describeModelError(error) };
  }

  return { status: 'done', finalMessage: lastMessage, toolUses, turns, toolCalls, tokens };
}

/**
 * The tool list with a breakpoint on its last definition.
 *
 * Copied rather than marked in place: the caller's array is reused across a
 * Round's free retries, and a marker written into it would be written twice.
 */
function withCacheBreakpoint(tools: RunLoopParams['tools']): RunLoopParams['tools'] {
  if (tools.length === 0) return [...tools];
  const last = { ...tools[tools.length - 1]!, cache_control: CACHE_CONTROL };
  return [...tools.slice(0, -1), last as RunLoopParams['tools'][number]];
}

/** Constructs the Tool Runner and the controller that aborts it — the setup the loop runs on. */
function buildRunner(params: RunLoopParams, ctx: ModelContext) {
  const settings = LOOP_SETTINGS[params.loop];
  const client = getAnthropicClient(ctx.credentials);

  // Aborting through `signal` is the only per-call lever the runner exposes, so
  // it is how a breached ceiling stops the loop.
  const controller = new AbortController();

  const betas = [...BASE_BETAS, ...(settings.contextEditing ? [CONTEXT_EDITING_BETA] : [])];

  const runner = client.beta.messages.toolRunner(
    {
      model: settings.model,
      max_tokens: MAX_TOKENS,
      system: params.system,
      messages: params.messages,
      /**
       * **The static prefix ends on the last tool definition** (SPEC §17.4).
       *
       * Nothing marked anything before this: `system` and `tools` went to the
       * SDK unmarked and `cache_read_input_tokens` was zero on every turn of
       * every Job ever run — 30 turns of the measured recommend Job included.
       * A Job's prefix is the app's best cache by a distance, because 50
       * resolve Jobs share one `system` plus tool digest and the stateless
       * evaluator shares a third across every Supplier.
       *
       * The list is **not sorted here**. `finalizeRegistry()`'s digest order is
       * already deterministic, and re-ordering it would change the bytes of
       * every recorded request body for no cache anybody was getting.
       */
      tools: withCacheBreakpoint(params.tools) as never,
      /**
       * Top-level `cache_control` **carries the tail**: it applies a marker to
       * the last cacheable block of the request automatically, which is what
       * makes the growing end of the conversation cacheable without this file
       * knowing where a Round boundary is. The Tool Runner constrains nothing
       * here — it hands the parameter straight to `messages.create` — so this
       * was never a decision about the runner (SPEC §17.1).
       */
      cache_control: CACHE_CONTROL,
      thinking: THINKING,
      output_config: { effort: settings.effort },
      /**
       * `stream` comes from the settings table, and only chat sets it.
       *
       * It changes what the runner yields — a `BetaMessageStream` per turn
       * rather than a finished `BetaMessage` — which is why the loop below
       * resolves each turn before doing anything with it. Every guarantee
       * downstream (write before checking, one `usage_event` per turn) is
       * stated in terms of a finished message, and a half-arrived one cannot
       * honour them.
       */
      stream: settings.stream,
      betas: betas as never,
      // Routes a refusal by category, with no model list of ours to maintain.
      fallbacks: 'default',
      ...(settings.contextEditing ? { context_management: CONTEXT_MANAGEMENT } : {}),
      max_iterations: MAX_ITERATIONS_BACKSTOP,
    } as never,
    { signal: controller.signal },
  );

  return { runner, controller };
}

/**
 * ── Write, before checking anything ──────────────────────────────────────
 *
 * Records this turn's tool uses and counts, and writes `trace_turn` +
 * `usage_event` (+ the pending `trace_tool_call` rows) before any cap or
 * budget check runs — a crash inside a tool still leaves the turn that
 * caused it on record.
 */
async function recordTurn(
  ctx: ModelContext,
  params: RunLoopParams,
  turn: BetaMessage,
): Promise<{ toolUses: { name: string; input: unknown }[]; toolCalls: number; tokens: number }> {
  const toolUses: { name: string; input: unknown }[] = [];
  for (const block of turn.content) {
    if (block.type === 'tool_use') toolUses.push({ name: block.name, input: block.input });
  }
  const toolCalls = toolCallsIn(turn);
  const tokens = tokensOf(turn);

  const traceTurnId = await writeTurn(ctx, params, turn);
  await writeUsage(ctx, turn, traceTurnId);
  await writeToolCalls(ctx, turn, traceTurnId);

  return { toolUses, toolCalls, tokens };
}

/** The Job's running totals as of this turn, which every stop reports back. */
type TurnCounts = {
  turns: number;
  toolCalls: number;
  tokens: number;
  toolUses: { name: string; input: unknown }[];
};

/**
 * ── Check caps, before letting the next tools run ────────────────────────
 *
 * This turn's stop reason, then the numbers somebody set, then the Run budget —
 * the whole "decide to continue" step, in that order. Returns the outcome to
 * return from `runLoop` when the loop must stop, or `undefined` to let the
 * `for await` fall through to the next turn.
 *
 * **The abort lives here and nowhere else.** Aborting through `signal` is the
 * only per-call lever the runner exposes, and a stop that forgot it would leave
 * the runner still running the tools of the turn it had just refused.
 */
async function checkCapsAndBudget(
  params: RunLoopParams,
  ctx: ModelContext,
  controller: AbortController,
  turn: BetaMessage,
  counts: TurnCounts,
): Promise<RunLoopOutcome | undefined> {
  const stopped = stopFromThisTurn(params, turn) ?? stopFromCeilings(params, ctx, counts);
  if (stopped) {
    controller.abort();
    return stopped;
  }

  // ── The run budget: checked at the Round boundary only ───────────────────
  // It PAUSES rather than terminating, because it is a spending decision a
  // person may revise. `paused_on_budget` is the only state that returns to
  // `running`.
  //
  // The check comes from the CONTEXT for a Job and from the params only where a
  // caller states one for a single loop; before both existed, nothing anywhere
  // supplied one and this branch was dead.
  const budgetCheck = params.budgetCheck ?? ctx.budgetCheck;
  if (budgetCheck && turn.stop_reason !== 'tool_use') {
    const budget = await budgetCheck();
    if (!budget.withinBudget) {
      controller.abort();
      return {
        status: 'paused_on_budget',
        spentUsd: budget.spentUsd,
        turns: counts.turns,
        toolCalls: counts.toolCalls,
        tokens: counts.tokens,
      };
    }
  }

  return undefined;
}

/**
 * What this turn's own `stop_reason` says: a refusal, or a truncation. Both are
 * `failed` — *something broke* — and neither is a number anybody set.
 */
function stopFromThisTurn(params: RunLoopParams, turn: BetaMessage): RunLoopOutcome | undefined {
  // ── A whole-chain refusal fails the Job ──────────────────────────────────
  // `failed`, meaning *something broke* — never `terminated`, which means
  // *a number you set*. The parameter routes what it can; this handles
  // what it cannot.
  if (turn.stop_reason === 'refusal') {
    const details = turn.stop_details as {
      category?: string | null;
      explanation?: string | null;
    } | null;
    return {
      status: 'failed',
      error: 'the model refused, and server-side fallback did not produce an answer',
      refusal: { category: details?.category ?? null, explanation: details?.explanation ?? null },
    };
  }

  /**
   * ── A truncated turn is a failure of ours, and says so ───────────────────
   *
   * `max_tokens` and `model_context_window_exceeded` both end the SDK's loop —
   * `determineNextStepFromStopReason` sorts them into `stop` — so the turn
   * arrived here as an ordinary `done` carrying a half-written final message.
   * Every caller then read that as *the model mis-shaped its output*, which
   * bought it two free retries against the same truncation and put the wrong
   * sentence in front of whoever read the Job afterwards.
   *
   * **A diagnostic that is wrong is worse than one that is missing** (finding
   * 72), so this is `failed` and it names the stop reason. Callers route
   * `failed` to a free retry too — a truncation is worth another attempt — but
   * they report it as the loop failing rather than as the draft's shape.
   */
  if (turn.stop_reason === 'max_tokens' || turn.stop_reason === 'model_context_window_exceeded') {
    return {
      status: 'failed',
      error:
        `the turn was cut off with stop_reason "${turn.stop_reason}", so its output is incomplete ` +
        `(max_tokens is ${MAX_TOKENS.toLocaleString('en-US')} — a truncation guard, never a budget)`,
    };
  }

  return undefined;
}

/**
 * The three numbers somebody set: the request backstop, the tool-call ceiling
 * and the token ceiling — plus the Job's upstream ceiling, which is reached
 * inside a tool and filed for this to find. Every one of them is `terminated`.
 */
function stopFromCeilings(
  params: RunLoopParams,
  ctx: ModelContext,
  counts: TurnCounts,
): RunLoopOutcome | undefined {
  const { turns, toolCalls, tokens, toolUses } = counts;

  /**
   * ── The Job's upstream ceiling, reached inside a tool ────────────────────
   *
   * Filed by the adapter, because a throw inside a tool becomes an `is_error`
   * tool result rather than escaping the loop. It is **the Job's own cap**, so
   * it terminates — the amber, re-runnable state — naming the ceiling rather
   * than the tool.
   */
  const fatal = ctx.jobId ? takeFatalToolError(ctx.jobId) : undefined;
  if (fatal) {
    return { status: 'terminated', reason: fatal.message, turns, toolCalls, tokens, toolUses };
  }

  // `max_iterations` stops SILENTLY, leaving stop_reason: 'tool_use' on a
  // truncated run. It is a backstop set far above our own ceiling, so if it
  // fires that is a bug in our counting, not a limit doing its job — and it
  // STOPS rather than only logging, because a backstop that is announced and
  // then stepped over is not a backstop.
  if (turns >= MAX_ITERATIONS_BACKSTOP) {
    console.error(
      `[model] runLoop(${params.loop}) hit max_iterations (${MAX_ITERATIONS_BACKSTOP}). ` +
        `This is a backstop and should be unreachable — our own ceiling is ${params.caps.toolCalls} tool calls.`,
    );
    return {
      status: 'terminated',
      reason: `stopped at the ${MAX_ITERATIONS_BACKSTOP}-request backstop, which should have been unreachable`,
      turns,
      toolCalls,
      tokens,
      toolUses,
    };
  }

  if (toolCalls > params.caps.toolCalls) {
    return {
      status: 'terminated',
      reason: `stopped at its ${params.caps.toolCalls}-tool-call ceiling`,
      turns,
      toolCalls,
      tokens,
      toolUses,
    };
  }
  if (params.caps.tokens > 0 && tokens > params.caps.tokens) {
    return {
      status: 'terminated',
      reason: `stopped at its ${params.caps.tokens.toLocaleString('en-US')}-token ceiling`,
      turns,
      toolCalls,
      tokens,
      toolUses,
    };
  }

  return undefined;
}

/**
 * Stores **the whole `BetaMessage` verbatim** (SPEC §3.7, §19.1).
 *
 * Not a projection. Replay drives the real Tool Runner through a `replayFetch`,
 * and a projection would force replay to *synthesise* a body — which is a
 * hand-edited fixture wearing a different hat.
 */
async function writeTurn(
  ctx: ModelContext,
  params: RunLoopParams,
  message: BetaMessage,
): Promise<string | undefined> {
  if (!ctx.jobId) return undefined; // chat has no Trace; the transcript is the record

  /**
   * `n` is **continuous across every call within one Job**, not per call.
   *
   * A Job runs `runLoop` several times — once per Round, plus a free retry when
   * the model mis-shapes its output — and a per-call counter restarts at 1 each
   * time, which collides with the `(job_id, n)` unique index. The collision
   * then surfaces as a *failed* loop, which the caller reads as a refinement
   * failure, which retries and collides again. One trace row is a turn of the
   * JOB, not of the call.
   */
  const [{ next }] = (await ctx.db
    .select({ next: sql<number>`coalesce(max(${t.traceTurn.n}), 0) + 1` })
    .from(t.traceTurn)
    .where(eq(t.traceTurn.jobId, ctx.jobId))) as [{ next: number }];

  const [row] = await ctx.db
    .insert(t.traceTurn)
    .values({
      jobId: ctx.jobId,
      n: next,
      request: {
        loop: params.loop,
        model: LOOP_SETTINGS[params.loop].model,
        effort: LOOP_SETTINGS[params.loop].effort,
        roundN: params.roundN ?? null,
        system: params.system,
        /**
         * The fingerprint of the body actually sent, filed by the capturing
         * fetch under this message's id (see `wire.ts`). It is what a replay
         * matches on, and it is the only part of this object that describes
         * turns 2..n rather than just the first.
         *
         * `bodyHash` is the same body's **raw** sha256 — the one identity that
         * survives a change to how the wire hash is computed, so a fixture can
         * be rehashed from dumped bodies instead of re-run. See `rawBodyHash`.
         */
        ...(() => {
          const hashes = takeWireHash(message.id);
          return { wireHash: hashes?.wire ?? null, bodyHash: hashes?.raw ?? null };
        })(),
      },
      // Stringified here, because the column is text — see the schema for why.
      response: JSON.stringify(message),
      stopReason: message.stop_reason ?? null,
      stopDetails: (message.stop_details ?? null) as never,
      toolNames: (params.toolDigest?.names ?? null) as never,
      toolDigestHash: params.toolDigest?.hash ?? null,
      ms: 0,
    })
    .returning({ id: t.traceTurn.id });
  return row?.id;
}

/**
 * One `trace_tool_call` row per `tool_use` block, written **before the tool
 * runs** (SPEC §3.7).
 *
 * ## Why the input is written here and the output elsewhere
 *
 * A turn's `tool_use` blocks carry the id, the name and the input, and they are
 * known the moment the turn is written. The *output* is not — the runner has
 * not executed anything yet. Waiting for it would mean a crash inside a tool
 * leaves no record of the call that caused it, which is the same reason the
 * turn itself is written before any check runs.
 *
 * So the row is inserted with a null output, and `tool-adapter.ts` fills it in
 * by `tool_use_id` when the tool returns. A tool that never returns leaves a
 * row with a null output, which is the honest record: it was called, and it did
 * not finish.
 */
async function writeToolCalls(
  ctx: ModelContext,
  message: BetaMessage,
  traceTurnId: string | undefined,
): Promise<void> {
  if (!traceTurnId) return; // Chat has no Trace; the transcript is the record.

  const uses = message.content.filter((block) => block.type === 'tool_use');
  if (uses.length === 0) return;

  await ctx.db.insert(t.traceToolCall).values(
    uses.map((block) => ({
      traceTurnId,
      toolUseId: block.id,
      toolName: block.name,
      input: block.input as never,
      ms: 0,
    })),
  );
}

/**
 * Usage lives on `usage_event`, **not** on `trace_turn` — one number, one home.
 *
 * Deriving spend from `trace_turn` would be blind to chat, which has no Trace.
 */
async function writeUsage(
  ctx: ModelContext,
  message: BetaMessage,
  traceTurnId: string | undefined,
): Promise<void> {
  const u = message.usage;
  await ctx.db.insert(t.usageEvent).values({
    runId: ctx.runId,
    jobId: ctx.jobId ?? null,
    endpoint: 'messages.toolRunner',
    ms: 0,
    outcome: 'ok',
    cacheHit: false,
    model: message.model,
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
    traceTurnId: traceTurnId ?? null,
  });
}

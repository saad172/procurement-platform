import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta';
import * as t from '@/db/schema';
import { MODEL_PRICE_USD_PER_MTOK } from '@/config/constants';
import { getAnthropicClient } from './client';
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

/** Sums the four token counts a turn reports, for the cap and for the price. */
function tokensOf(message: BetaMessage): number {
  const u = message.usage;
  return (
    (u.input_tokens ?? 0) +
    (u.output_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0)
  );
}

/**
 * Dollars from a **committed price constant, not a bill** — which the UI says
 * out loud wherever it renders one.
 *
 * Keyed by model id though we only ever ask for one, because server-side
 * refusal fallback can serve a turn from a model we did not choose.
 */
export function priceOf(message: BetaMessage): number {
  const price = MODEL_PRICE_USD_PER_MTOK[message.model] ?? MODEL_PRICE_USD_PER_MTOK['claude-opus-5']!;
  const u = message.usage;
  const input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  return (input / 1_000_000) * price.input + ((u.output_tokens ?? 0) / 1_000_000) * price.output;
}

/** Counts `tool_use` blocks, which is what the ceiling actually bounds. */
function toolCallsIn(message: BetaMessage): number {
  return message.content.filter((block) => block.type === 'tool_use').length;
}

export async function runLoop(
  params: RunLoopParams,
  ctx: ModelContext,
): Promise<RunLoopOutcome> {
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
      tools: params.tools as never,
      thinking: THINKING,
      output_config: { effort: settings.effort },
      betas: betas as never,
      // Routes a refusal by category, with no model list of ours to maintain.
      fallbacks: 'default',
      ...(settings.contextEditing ? { context_management: CONTEXT_MANAGEMENT } : {}),
      max_iterations: MAX_ITERATIONS_BACKSTOP,
    } as never,
    { signal: controller.signal },
  );

  let turns = 0;
  let toolCalls = 0;
  let tokens = 0;
  let lastMessage: BetaMessage | undefined;

  try {
    for await (const message of runner) {
      const turn = message as BetaMessage;
      turns += 1;
      lastMessage = turn;

      // ── Write, before checking anything ──────────────────────────────────
      const turnToolCalls = toolCallsIn(turn);
      const turnTokens = tokensOf(turn);
      toolCalls += turnToolCalls;
      tokens += turnTokens;

      const traceTurnId = await writeTurn(ctx, params, turn, turns);
      await writeUsage(ctx, turn, traceTurnId);

      // ── A whole-chain refusal fails the Job ──────────────────────────────
      // `failed`, meaning *something broke* — never `terminated`, which means
      // *a number you set*. The parameter routes what it can; this handles
      // what it cannot.
      if (turn.stop_reason === 'refusal') {
        controller.abort();
        const details = turn.stop_details as { category?: string | null; explanation?: string | null } | null;
        return {
          status: 'failed',
          error: 'the model refused, and server-side fallback did not produce an answer',
          refusal: { category: details?.category ?? null, explanation: details?.explanation ?? null },
        };
      }

      // `max_iterations` stops SILENTLY, leaving stop_reason: 'tool_use' on a
      // truncated run. It is a backstop set far above our own ceiling, so if it
      // fires that is a bug in our counting, not a limit doing its job.
      if (turns >= MAX_ITERATIONS_BACKSTOP) {
        console.error(
          `[model] runLoop(${params.loop}) hit max_iterations (${MAX_ITERATIONS_BACKSTOP}). ` +
            `This is a backstop and should be unreachable — our own ceiling is ${params.caps.toolCalls} tool calls.`,
        );
      }

      // ── Check caps, before letting the next tools run ────────────────────
      if (toolCalls > params.caps.toolCalls) {
        controller.abort();
        return {
          status: 'terminated',
          reason: `stopped at its ${params.caps.toolCalls}-tool-call ceiling`,
          turns,
          toolCalls,
          tokens,
        };
      }
      if (params.caps.tokens > 0 && tokens > params.caps.tokens) {
        controller.abort();
        return {
          status: 'terminated',
          reason: `stopped at its ${params.caps.tokens.toLocaleString('en-US')}-token ceiling`,
          turns,
          toolCalls,
          tokens,
        };
      }

      // ── The run budget: checked at the Round boundary only ───────────────
      // It PAUSES rather than terminating, because it is a spending decision a
      // person may revise. `paused_on_budget` is the only state that returns to
      // `running`.
      if (params.budgetCheck && turn.stop_reason !== 'tool_use') {
        const budget = await params.budgetCheck();
        if (!budget.withinBudget) {
          controller.abort();
          return { status: 'paused_on_budget', spentUsd: budget.spentUsd, turns, toolCalls, tokens };
        }
      }
    }
  } catch (error) {
    if (controller.signal.aborted) {
      // An abort we initiated has already returned its outcome above; reaching
      // here means the abort raced the iterator, so report what we counted.
      return { status: 'terminated', reason: 'aborted at a ceiling', turns, toolCalls, tokens };
    }
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
  }

  return { status: 'done', finalMessage: lastMessage, turns, toolCalls, tokens };
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
  n: number,
): Promise<string | undefined> {
  if (!ctx.jobId) return undefined; // chat has no Trace; the transcript is the record
  const [row] = await ctx.db
    .insert(t.traceTurn)
    .values({
      jobId: ctx.jobId,
      n,
      request: {
        loop: params.loop,
        model: LOOP_SETTINGS[params.loop].model,
        effort: LOOP_SETTINGS[params.loop].effort,
        roundN: params.roundN ?? null,
      },
      response: message as never,
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

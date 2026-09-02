import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool';
import type { BetaToolResultContentBlockParam } from '@anthropic-ai/sdk/resources/beta';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import * as t from '@/db/schema';
import type { ToolContext, ToolDefinition } from '@/tools';
import {
  TOOL_OBJECTION_KINDS,
  UpstreamCacheMissError,
  UpstreamCapExceededError,
  UpstreamError,
} from '@/upstream/errors';

/**
 * The adapter from our registry to the Tool Runner (SPEC §15.1).
 *
 * **It lives in `src/model/` rather than in `src/tools/` because the import
 * boundary put it here**, and that is the boundary working as intended: only
 * `src/model/**` may import `@anthropic-ai/sdk`, so the one file that has to
 * know about both the registry and the SDK belongs on the model side of the
 * line. A registry that imported the SDK would have made the boundary a lie.
 *
 * `strict: true` is on every model-facing tool and it is **free** —
 * `betaZodTool` already emits `additionalProperties: false` and `required` at
 * every level. That is what makes a JSON Schema violation **impossible**
 * rather than merely caught (SPEC §10.5, tier 1).
 */

export type CapturedCall = { name: string; input: unknown };

/**
 * Wraps one registry tool.
 *
 * The `run` function is where `ctx` is injected — handlers never import their
 * dependencies, because the worker is one process that would otherwise need
 * both a pooled and a direct connection at import time.
 */
export function toRunnableTool(
  tool: ToolDefinition,
  ctx: ToolContext,
  onCall?: (call: CapturedCall) => void,
): BetaRunnableTool<never> {
  const runnable = betaZodTool({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.input as never,
    run: async (input, context) => {
      onCall?.({ name: tool.name, input });

      const startedAt = Date.now();

      /**
       * A handler that **throws** is recorded too.
       *
       * The first version recorded only handlers that returned, so a tool that
       * threw left a row with a null output and a null `ok` — indistinguishable
       * from one still running. That is the state a Trace is least able to
       * afford: the calls worth reading are usually the ones that went wrong.
       *
       * The throw is re-raised unchanged, so the runner still reports it to the
       * model exactly as it would have.
       */
      let result: Awaited<ReturnType<typeof tool.handler>>;
      try {
        result = await tool.handler(input, ctx);
      } catch (error) {
        /**
         * ── An upstream failure is told to the model as a sentence ──────────
         *
         * `src/tools/catalog/lookups.ts` has no `try` of its own, so a 429, a
         * timeout, a 5xx or a keyless cache miss travelled to the model as the
         * SDK's `Error: <message>` string — unstructured, unattributed, and
         * with the loop spending on regardless. `isObjection` and
         * `OBJECTIONABLE_KINDS` existed for exactly this and had no caller
         * anywhere under `src/tools`.
         *
         * The upstream ceiling is the exception, and it is recorded as one:
         * that is **the Job's own cap**, not a failure of the tool, so it stops
         * the loop rather than inviting the model to work around it.
         */
        const objection = upstreamObjection(error);
        if (error instanceof UpstreamCapExceededError && ctx.jobId) {
          rememberFatal(ctx.jobId, error);
        }
        await recordOutcome(
          ctx,
          context?.toolUse?.id,
          {
            ok: false,
            objections: [
              objection ??
                `the handler threw: ${error instanceof Error ? error.message : String(error)}`,
            ],
          },
          Date.now() - startedAt,
        );
        if (!objection) throw error;
        return visibleObjections([objection]);
      }
      await recordOutcome(ctx, context?.toolUse?.id, result, Date.now() - startedAt);

      // A handler returning objections renders as a VISIBLE BLOCK listing them
      // verbatim, and the model is told — so it adjusts rather than retrying
      // blind. Never an apology in place of what happened.
      if (!result.ok) return visibleObjections(result.objections);
      return JSON.stringify(modelPayload(result.data));
    },
  }) as BetaRunnableTool<never>;

  return { ...runnable, parse: recordingParse(runnable, ctx) };
}

/**
 * The repo's one shape for telling a model that something did not work.
 *
 * A **visible block** listing the reasons verbatim — never an apology in place
 * of what happened, and never a summary, because the model adjusts from the
 * reason and not from the tone.
 */
export function visibleObjections(
  objections: readonly string[],
): BetaToolResultContentBlockParam[] {
  return [
    {
      type: 'text',
      text: `This did not work. The reasons, verbatim:\n${objections.map((o) => `- ${o}`).join('\n')}`,
    },
  ];
}

/**
 * One sentence naming **source, endpoint and kind**, or nothing when the
 * failure is not one a model could act on.
 *
 * A cache miss is included: in a keyless replay it means *the request changed
 * since the fixture was recorded*, which the loud error still says in full on
 * the row and in the log — and the alternative was the SDK's own `Error:`
 * string, which said the same thing to the model with less structure.
 */
export function upstreamObjection(error: unknown): string | undefined {
  if (error instanceof UpstreamCacheMissError) {
    return `${error.message.split('\n')[0]} This wrapper has no credentials, so it cannot fall through to a live call.`;
  }
  if (error instanceof UpstreamCapExceededError) return undefined;
  if (!(error instanceof UpstreamError) || !TOOL_OBJECTION_KINDS.has(error.kind)) return undefined;
  return `${error.source} ${error.endpoint} did not answer: ${error.kind} — ${error.message}. This is the source, not your query; try a different tool or say what you could not check.`;
}

/**
 * The Job's upstream ceiling, remembered until the chokepoint reads it.
 *
 * **A throw inside a tool cannot stop the loop**: the runner catches it into an
 * `is_error` tool result and asks the model what to do next, which is precisely
 * the wrong question for a ceiling — the answer is *stop*. Nothing else in the
 * SDK reaches from a tool back to the loop that is running it.
 *
 * So the ceiling is filed under the `jobId` and `runLoop()` takes it on its next
 * turn, the same trick the wire hash uses with the message id and for the same
 * reason: no state has to be threaded through the Tool Runner, and it stays
 * correct when four Jobs run at once. The honest cost is **one more model
 * request** — the turn that reads the error result — after which the loop
 * aborts and no further tool call is made, which is what the upstream ceiling
 * is protecting.
 */
const fatalByJob = new Map<string, Error>();

function rememberFatal(jobId: string, error: Error): void {
  fatalByJob.set(jobId, error);
}

export function takeFatalToolError(jobId: string): Error | undefined {
  const error = fatalByJob.get(jobId);
  fatalByJob.delete(jobId);
  return error;
}

/**
 * The tool's own `parse`, with the failure written down.
 *
 * **The runner parses before it runs.** `generateToolResponse` calls
 * `tool.parse(input)` inside its own `try`, so a zod failure becomes an
 * `is_error` tool result and `run` is never entered — which means `onCall`
 * never fires and `recordOutcome` never fires either. The `trace_tool_call` row
 * that `runLoop` opened before the tool ran was therefore left with a null
 * output and a null `ok`: **indistinguishable from a tool that was called and
 * never returned**, which is the one state a Trace can least afford, and the
 * same fault the throwing-handler case was fixed for.
 *
 * It is the *model's* mistake rather than ours, so the issues are recorded as
 * objections — the same shape a handler's own refusal takes — and the throw is
 * re-raised unchanged, so the runner still tells the model exactly what it
 * would have.
 */
function recordingParse(
  runnable: { name: string; parse: (input: unknown) => unknown },
  ctx: ToolContext,
): (input: unknown) => never {
  return ((input: unknown) => {
    try {
      return runnable.parse(input);
    } catch (error) {
      void recordParseFailure(ctx, runnable.name, input, describeParseError(error));
      throw error;
    }
  }) as (input: unknown) => never;
}

/** A zod issue list, in the model's own field names; anything else, verbatim. */
function describeParseError(error: unknown): string[] {
  const issues = (error as { issues?: { path: (string | number)[]; message: string }[] }).issues;
  if (!issues) {
    return [`the input did not parse: ${error instanceof Error ? error.message : String(error)}`];
  }
  return issues.map((issue) => `${issue.path.join('.') || '(root)'} — ${issue.message}`);
}

/**
 * Completes the row by **the input the call carried**, because `parse` is not
 * given the `tool_use` id.
 *
 * The runner hands `run` a context holding the block; `parse` gets the raw
 * input alone. `writeToolCalls` stored that same input verbatim moments
 * earlier, on the newest turn of this Job, so it identifies the row — and the
 * `output IS NULL` clause keeps a second, identical call in an earlier turn out
 * of it.
 *
 * Like `recordOutcome`, it never fails the tool: bookkeeping that can break a
 * live Job is worse than no bookkeeping.
 */
async function recordParseFailure(
  ctx: ToolContext,
  toolName: string,
  input: unknown,
  objections: string[],
): Promise<void> {
  if (!ctx.jobId) return; // Chat has no Trace; the transcript is the record.
  try {
    const [row] = await ctx.db
      .select({ id: t.traceToolCall.id })
      .from(t.traceToolCall)
      .innerJoin(t.traceTurn, eq(t.traceTurn.id, t.traceToolCall.traceTurnId))
      .where(
        and(
          eq(t.traceTurn.jobId, ctx.jobId),
          eq(t.traceToolCall.toolName, toolName),
          isNull(t.traceToolCall.output),
          sql`${t.traceToolCall.input} = ${JSON.stringify(input ?? null)}::jsonb`,
        ),
      )
      .orderBy(desc(t.traceTurn.n))
      .limit(1);
    if (!row) return;

    await ctx.db
      .update(t.traceToolCall)
      .set({ output: { objections } as never, ok: false as never, ms: 0 })
      .where(eq(t.traceToolCall.id, row.id));
  } catch (error) {
    console.error(`[model] could not record the refused input to ${toolName}:`, error);
  }
}

/**
 * What the model is given: the **data half only**, never the widget.
 *
 * Every chat-reachable read returns `{ data, widget }` with no opt-out — the
 * widget is what freezes onto a message so a person sees the figure rather than
 * reading it in prose. It is a **display** artifact, and the chat adapter has
 * always unwrapped it. The Job adapter did not, with two consequences:
 *
 * 1. **Every Job tool result was sent twice.** `sourceResult` nests the payload
 *    inside the widget as well as beside it, so a 30 KB entity arrived as 60 KB.
 * 2. **Replay was impossible.** The widget carries `cacheHit`, which is `false`
 *    on a live recording and `true` on every replayed read — so the tool result
 *    differed, the next request differed, and the fixture missed. It surfaced as
 *    a replay miss on turn 6 of `resolve/agree-r1`, five turns after the last
 *    thing that had changed.
 *
 * Neither is the widget's fault. It is genuinely useful, to a person, and
 * `cacheHit` is genuinely true — the mistake was letting a display artifact
 * reach a prompt at all.
 */
function modelPayload(data: unknown): unknown {
  if (data && typeof data === 'object' && 'widget' in data && 'data' in data) {
    return (data as { data: unknown }).data;
  }
  return data;
}

/**
 * Completes the `trace_tool_call` row that `runLoop` opened for this call.
 *
 * The row is matched on `tool_use_id`, which the runner hands to `run` in its
 * context. That id is the model's own, unique per call, so no state has to be
 * threaded from `runLoop` down to here — the same trick the wire hash uses with
 * the message id, for the same reason.
 *
 * **It never fails the tool.** A Trace row is bookkeeping; bookkeeping that can
 * break a live Job is worse than no bookkeeping. A missing row shows up as a
 * call with a null output, which reads correctly as "it was called and we do
 * not have its result".
 */
async function recordOutcome(
  ctx: ToolContext,
  toolUseId: string | undefined,
  result: { ok: true; data: unknown } | { ok: false; objections: string[] },
  ms: number,
): Promise<void> {
  if (!toolUseId) return;
  try {
    await ctx.db
      .update(t.traceToolCall)
      .set({
        output: (result.ok ? result.data : { objections: result.objections }) as never,
        ok: result.ok as never,
        ms,
      })
      .where(eq(t.traceToolCall.toolUseId, toolUseId));
  } catch (error) {
    console.error(`[model] could not record the result of ${toolUseId}:`, error);
  }
}

/**
 * Wraps a derived tool list. The list itself always comes from
 * `finalizeRegistry()` — there is no way to hand-write one.
 */
export function toRunnableTools(
  tools: readonly ToolDefinition[],
  ctx: ToolContext,
  onCall?: (call: CapturedCall) => void,
): BetaRunnableTool<never>[] {
  return tools.map((tool) => toRunnableTool(tool, ctx, onCall));
}

/**
 * A `submit_*` handler writes nothing — it hands the payload back, and the Job
 * runs the eight checks over it before a single row is inserted.
 *
 * The payload itself is read from `RunLoopOutcome.toolUses` rather than from
 * here, so the write path does not depend on whether the runner chose to
 * execute a terminal tool. See `EmittedToolUse` for why that matters.
 */
export const SUBMIT_TOOLS_PROPOSE_ONLY = true;

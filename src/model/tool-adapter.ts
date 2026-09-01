import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool';
import { eq } from 'drizzle-orm';
import * as t from '@/db/schema';
import type { ToolContext, ToolDefinition } from '@/tools';

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
  return betaZodTool({
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
        await recordOutcome(
          ctx,
          context?.toolUse?.id,
          {
            ok: false,
            objections: [
              `the handler threw: ${error instanceof Error ? error.message : String(error)}`,
            ],
          },
          Date.now() - startedAt,
        );
        throw error;
      }
      await recordOutcome(ctx, context?.toolUse?.id, result, Date.now() - startedAt);

      // A handler returning objections renders as a VISIBLE BLOCK listing them
      // verbatim, and the model is told — so it adjusts rather than retrying
      // blind. Never an apology in place of what happened.
      if (!result.ok) {
        return [
          {
            type: 'text',
            text: `This did not work. The reasons, verbatim:\n${result.objections.map((o) => `- ${o}`).join('\n')}`,
          },
        ];
      }
      return JSON.stringify(modelPayload(result.data));
    },
  }) as BetaRunnableTool<never>;
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

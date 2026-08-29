import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool';
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
    run: async (input) => {
      onCall?.({ name: tool.name, input });
      const result = await tool.handler(input, ctx);

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
      return JSON.stringify(result.data);
    },
  }) as BetaRunnableTool<never>;
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

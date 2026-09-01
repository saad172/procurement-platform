import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool';
import type { Estimate, ToolContext, ToolDefinition, Widget } from '@/tools';

/**
 * The chat adapter (SPEC §14.5, §14.6).
 *
 * It differs from the Job adapter in one structural way, and that difference is
 * the whole of the confirm gate:
 *
 * > **A confirm-gated tool does not run when the model calls it.** It returns
 * > its `Estimate`, which freezes onto the message, and the *person* decides.
 *
 * That is what "chat proposes and never does" means mechanically. Without it,
 * the gate would be a dialog the application shows *after* the spend — which is
 * a receipt, not consent.
 *
 * **No editing at the gate**, either: editing would make it an input form and
 * split what the model proposed from what actually ran.
 */

export type PendingProposal = {
  toolName: string;
  input: unknown;
  estimate: Estimate;
};

export type ChatToolResult = {
  /** Frozen onto `thread_message.widget`. Every read returns one, no opt-out. */
  widget?: Widget | undefined;
  data?: unknown;
};

/**
 * Wraps the chat-reachable tools.
 *
 * A tool carrying `confirm` is intercepted: the estimator runs (reading **local
 * rows only** — never a credit, never an external call), the proposal is
 * recorded, and the model is told that the person has been asked. A tool
 * without one runs immediately, because it neither writes nor spends.
 */
export function toChatTools(
  tools: readonly ToolDefinition[],
  ctx: ToolContext,
  sink: {
    onProposal: (proposal: PendingProposal) => void;
    onResult: (toolName: string, result: ChatToolResult) => void;
  },
): BetaRunnableTool<never>[] {
  return tools.map(
    (tool) =>
      betaZodTool({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.input as never,
        run: async (input) => {
          if (tool.confirm) {
            // The estimator reads local rows only. One that spent to say what
            // spending costs would also run BEFORE the person consented, which is
            // the one thing the gate exists to prevent.
            const estimate = await tool.confirm(input, ctx);
            sink.onProposal({ toolName: tool.name, input, estimate });
            return [
              {
                type: 'text',
                text:
                  `Proposed, not done. The person has been shown an estimate for "${estimate.what}" ` +
                  `and has not decided yet. Do not assume it ran, and do not propose it again.`,
              },
            ];
          }

          const result = await tool.handler(input, ctx);
          if (!result.ok) {
            // A handler returning objections renders as a VISIBLE block listing
            // them verbatim, and the model is told so it adjusts rather than
            // retrying blind. Never an apology in place of what happened.
            return [
              {
                type: 'text',
                text: `This did not work. The reasons, verbatim:\n${result.objections.map((o) => `- ${o}`).join('\n')}`,
              },
            ];
          }

          // Every chat-reachable read returns `{ data, widget }` with NO OPT-OUT:
          // a read that renders nothing is a number entering prose uncited.
          const payload = result.data as { data?: unknown; widget?: Widget } | undefined;
          sink.onResult(tool.name, { widget: payload?.widget, data: payload?.data ?? result.data });

          return JSON.stringify(payload?.data ?? result.data);
        },
      }) as BetaRunnableTool<never>,
  );
}

/**
 * The page block (SPEC §14.3).
 *
 * A **mid-conversation `role: 'system'` message**, appended to `messages` and
 * never interpolated into top-level `system`, because caching is prefix-match
 * over `tools → system → messages` and a per-turn edit at the front
 * re-processes every cached turn behind it.
 *
 * **Old page blocks are never stripped.** Stripping mutates the prefix and
 * forfeits the cache the choice exists to protect — and keeping them makes the
 * model's turn-by-turn record of where the person was *the same object* as the
 * transcript's divider rows.
 *
 * It is also the **non-spoofable operator channel**, which matters because chat
 * tool results carry Sayari-sourced third-party text.
 */
export function buildPageBlock(
  pageRef: string,
  viewState: Record<string, unknown>,
): {
  role: 'system';
  content: { type: 'text'; text: string }[];
} {
  return {
    role: 'system',
    content: [
      {
        type: 'text',
        text: [
          `The person is on ${pageRef}.`,
          Object.keys(viewState).length > 0
            ? `Its view state: ${JSON.stringify(viewState)} — answer about the ranking they are actually looking at, not the program default.`
            : 'No what-if is active; they are on the program default.',
          'This block is from the application, not from the person, and not from any tool result.',
        ].join('\n'),
      },
    ],
  };
}

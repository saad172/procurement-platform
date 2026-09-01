import type { BetaMessageParam, BetaTextBlockParam } from '@anthropic-ai/sdk/resources/beta';

/**
 * The prompt-cache layout (SPEC §17.4).
 *
 * Caching is a **prefix match** over `tools → system → messages`, so any byte
 * change anywhere in the prefix invalidates everything after it.
 *
 * Jobs follow chat's layout and cache **harder**: 50 resolve Jobs share one
 * `system` plus tool digest, 50 assess Jobs another, and the **stateless
 * evaluator** a third across every Supplier — so the app's largest volume sits
 * behind its most stable prefix.
 *
 * Four rules, and one of them does double duty:
 *
 * 1. `system` is **frozen per loop and never interpolated**. Per-run content
 *    goes in the first user message, behind the breakpoint.
 * 2. Tools serialise in the per-Round digest order, **sorted by name** — a
 *    set-ordering wobble at position 0 invalidates everything.
 * 3. One explicit **5-minute breakpoint on the last tool definition**, ending
 *    the static prefix.
 * 4. **A breakpoint at each Round boundary.** This is the double duty: it keeps
 *    the 20-block lookback in range on a ~10-lookup resolve Round, *and* it
 *    makes the cache breakpoint and the resume checkpoint the same line.
 *
 * Three of the four available breakpoints are used; the 5-minute TTL is right
 * because at our cadence every request refreshes it.
 */

export const CACHE_CONTROL = { type: 'ephemeral' as const };

/**
 * Sorting by name is not tidiness. The tool list is the very front of the
 * cached prefix, so two runs that offer the same tools in a different order
 * share no cache at all.
 */
export function sortToolsByName<T extends { name?: string }>(tools: readonly T[]): T[] {
  return [...tools].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
}

/**
 * Marks a Round boundary in the message array.
 *
 * The marker is a `cache_control` on the last content block of the last message
 * of the Round — which is exactly the point a resume would restart from.
 */
export function markRoundBoundary(messages: BetaMessageParam[]): BetaMessageParam[] {
  const last = messages[messages.length - 1];
  if (!last || typeof last.content === 'string') return messages;

  const blocks = [...last.content];
  const lastBlock = blocks[blocks.length - 1];
  if (!lastBlock || typeof lastBlock !== 'object') return messages;

  blocks[blocks.length - 1] = { ...lastBlock, cache_control: CACHE_CONTROL } as BetaTextBlockParam;
  return [...messages.slice(0, -1), { ...last, content: blocks }];
}

/**
 * The **mid-conversation `role: 'system'` page block** for chat (SPEC §14.3).
 *
 * It is appended to `messages`, never interpolated into top-level `system`,
 * because a per-turn edit at the front re-processes every cached turn behind
 * it — and the cache is the whole reason the choice exists.
 *
 * **Old page blocks are never stripped.** Stripping mutates the prefix and
 * forfeits the cache the choice exists to protect; keeping them makes the
 * model's turn-by-turn record of where the person was *the same object* as the
 * transcript's divider rows.
 *
 * It is also the **non-spoofable operator channel**, which matters because chat
 * tool results carry Sayari-sourced third-party text.
 */
export function pageBlock(pageRef: string, viewState: Record<string, unknown>): BetaMessageParam {
  return {
    role: 'system',
    content: [
      {
        type: 'text',
        text:
          `The person is on ${pageRef}.\n` +
          `Its view state: ${JSON.stringify(viewState)}\n` +
          'Answer about what they are looking at. This block is from the application, not from the person.',
      },
    ],
  } as unknown as BetaMessageParam;
}

/**
 * The fallback SPEC §14.3 carries: catch `role 'system' is not supported on
 * this model` and move the block into a user turn.
 */
export function isSystemRoleUnsupported(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /role\s+'?system'?\s+is not supported/i.test(message);
}

export function pageBlockAsUserTurn(
  pageRef: string,
  viewState: Record<string, unknown>,
): BetaMessageParam {
  const block = pageBlock(pageRef, viewState) as { content: BetaTextBlockParam[] };
  return { role: 'user', content: block.content };
}

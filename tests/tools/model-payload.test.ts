import { describe, expect, it } from 'vitest';
import { getRegistry } from '@/tools';

/**
 * **What the model reads is not what the widget renders**, and the difference
 * is deliberate.
 *
 * A read tool returns `{ data, widget }`: `data` goes into a prompt, `widget`
 * freezes onto a message for a person. Handing the model whole database rows
 * put the app's bookkeeping — `settledAt`, `jobId`, `supersedesId`, `isCurrent`
 * — in front of a loop whose every sentence must cite something. Those are
 * facts about **when we ran**, not about the Supplier, and no Assessment
 * sentence should ever quote one.
 *
 * These assertions read the tool's declared shape rather than a live call, so
 * they hold without a database.
 */
describe('get_supplier', () => {
  it('describes itself as a read that renders', () => {
    const tool = getRegistry().byName.get('get_supplier')!;
    expect(tool.effect).toBe('read');
    // Every chat-reachable read returns a widget with no opt-out: a read that
    // renders nothing is a number entering prose uncited.
    expect(tool.surfaces).toContain('chat');
  });
});

/**
 * The catalog-wide invariant behind it: a tool that spends must be
 * confirm-gated on chat, and a tool that renders must reach chat at all. Both
 * are checked by `finalizeRegistry()` at boot; this asserts the boot check is
 * actually reached, because an invariant nobody runs is a comment.
 */
describe('the registry', () => {
  it('finalises without throwing, which is where the invariants live', () => {
    expect(() => getRegistry()).not.toThrow();
  });

  it('gates every chat-reachable spender behind a confirm', () => {
    for (const tool of getRegistry().forSurface('chat')) {
      if (tool.spends.length > 0) {
        expect(tool.confirm, `${tool.name} spends and is reachable from chat`).toBeDefined();
      }
    }
  });
});

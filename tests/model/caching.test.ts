import { describe, expect, it } from 'vitest';
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta';
import {
  CACHE_CONTROL,
  isSystemRoleUnsupported,
  markRoundBoundary,
  pageBlock,
  pageBlockAsUserTurn,
  sortToolsByName,
} from '@/model';

/**
 * SPEC §17.4 and §14.3. Caching is a prefix match over `tools → system →
 * messages`, so every test here is really about *not moving the prefix*.
 */

describe('tool ordering', () => {
  it('sorts by name, because a set-ordering wobble at position 0 invalidates everything', () => {
    const sorted = sortToolsByName([{ name: 'get_z' }, { name: 'get_a' }, { name: 'get_m' }]);
    expect(sorted.map((t) => t.name)).toEqual(['get_a', 'get_m', 'get_z']);
  });

  it('is stable, so two runs offering the same tools share a cache', () => {
    const a = sortToolsByName([{ name: 'b' }, { name: 'a' }]);
    const b = sortToolsByName([{ name: 'a' }, { name: 'b' }]);
    expect(a).toEqual(b);
  });
});

describe('the Round boundary breakpoint', () => {
  it('marks the last block of the last message', () => {
    const messages: BetaMessageParam[] = [
      { role: 'user', content: [{ type: 'text', text: 'one' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'two' },
          { type: 'text', text: 'three' },
        ],
      },
    ];
    const marked = markRoundBoundary(messages);
    const last = marked[1]!.content as { cache_control?: unknown }[];
    expect(last[1]!.cache_control).toEqual(CACHE_CONTROL);
    expect(last[0]!.cache_control).toBeUndefined();
  });

  it('does not mutate the input, so a retry starts from the same array', () => {
    const messages: BetaMessageParam[] = [{ role: 'user', content: [{ type: 'text', text: 'x' }] }];
    markRoundBoundary(messages);
    expect(
      (messages[0]!.content as { cache_control?: unknown }[])[0]!.cache_control,
    ).toBeUndefined();
  });

  it('leaves a string-content message alone rather than reshaping it', () => {
    const messages: BetaMessageParam[] = [{ role: 'user', content: 'plain' }];
    expect(markRoundBoundary(messages)).toEqual(messages);
  });
});

describe('the chat page block', () => {
  it('is a mid-conversation system message, not an edit to top-level system', () => {
    // A per-turn edit at the front re-processes every cached turn behind it,
    // and the cache is the whole reason the choice exists.
    const block = pageBlock('/program/p1/category/HAR', { w: { compliance_risk: 40 } });
    expect(block.role).toBe('system');
  });

  it('carries the page AND its view state, so chat sees the ranking the person sees', () => {
    const block = pageBlock('/program/p1', { weights: { compliance_risk: 40 }, facets: ['DEU'] });
    const text = (block.content as { text: string }[])[0]!.text;
    expect(text).toContain('/program/p1');
    expect(text).toContain('compliance_risk');
    expect(text).toContain('DEU');
  });

  it('says it is from the application, because it is the operator channel', () => {
    // It matters because chat tool results carry Sayari-sourced third-party
    // text, and this block must not be spoofable from inside one.
    const text = (pageBlock('/x', {}).content as { text: string }[])[0]!.text;
    expect(text).toMatch(/from the application, not from the person/);
  });

  it('has a documented fallback into a user turn', () => {
    expect(isSystemRoleUnsupported(new Error("role 'system' is not supported on this model"))).toBe(
      true,
    );
    expect(isSystemRoleUnsupported(new Error('rate limited'))).toBe(false);
    const fallback = pageBlockAsUserTurn('/x', { a: 1 });
    expect(fallback.role).toBe('user');
    expect((fallback.content as { text: string }[])[0]!.text).toContain('/x');
  });
});

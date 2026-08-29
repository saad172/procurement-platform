import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { DOSSIER_PROFILE, MATCH_RUNGS_BY_ROUND, finalizeRegistry } from '@/tools/registry';
import type { ToolDefinition } from '@/tools/define';

/**
 * SPEC §15.5.
 *
 * **`registry.test.ts` exists to assert the validator REJECTS**, not to
 * re-check each tool. A test that re-listed the catalog would go stale beside
 * it and would prove nothing about the guard.
 *
 * Every case below is a tool someone could plausibly add without thinking —
 * which is exactly the failure the boot check exists to stop, and the reason it
 * is a boot check rather than a code review convention.
 */

const tool = (overrides: Partial<ToolDefinition>): ToolDefinition =>
  ({
    name: 'get_thing',
    description: 'Gets a thing.',
    input: z.object({}),
    surfaces: ['chat'],
    effect: 'read',
    spends: [],
    latency: 'fast',
    handler: async () => ({ ok: true, data: null }),
    ...overrides,
  }) as ToolDefinition;

/** The minimum set that satisfies the Dossier and Match invariants. */
const scaffold = (): ToolDefinition[] => [
  ...DOSSIER_PROFILE.map((name) =>
    tool({
      name,
      surfaces: name.startsWith('submit_') ? ['mcp'] : ['job', 'mcp'],
      effect: name.startsWith('submit_') ? 'write' : 'read',
      spends: name.startsWith('sayari_') ? ['sayari'] : [],
    }),
  ),
  ...['find_candidates_by_name_town', 'find_candidates_by_address', 'find_lei_by_name', 'join_lei'].map((name) =>
    tool({ name, surfaces: ['job'], spends: ['sayari'] }),
  ),
  tool({ name: 'submit_match_proposal', surfaces: ['job'], effect: 'write' }),
  tool({ name: 'submit_match_verdict', surfaces: ['job'], effect: 'write' }),
];

describe('finalizeRegistry accepts a legal registry', () => {
  it('does not throw on the scaffold', () => {
    expect(() => finalizeRegistry(scaffold())).not.toThrow();
  });
});

describe('finalizeRegistry rejects', () => {
  const rejects = (extra: ToolDefinition[], pattern: RegExp) =>
    expect(() => finalizeRegistry([...scaffold(), ...extra])).toThrow(pattern);

  it('a duplicate name', () => {
    rejects([tool({ name: 'get_supplier' })], /duplicate tool name/);
  });

  it('a name that does not match the scheme', () => {
    rejects([tool({ name: 'doStuff' })], /naming scheme/);
  });

  it('a chat-reachable write that is not an enqueue_*', () => {
    // Chat proposes and never does. A write it can reach must enqueue the same
    // Job the page's own button would.
    rejects(
      [tool({ name: 'get_write_thing', effect: 'write', surfaces: ['chat'], confirm: async () => ({ what: '', spends: {}, basis: '', caveats: [] }) })],
      /must be named enqueue_\*/,
    );
  });

  it('a chat-reachable write with no confirm gate', () => {
    rejects([tool({ name: 'enqueue_thing', effect: 'write', surfaces: ['chat'] })], /must carry a confirm gate/);
  });

  it('a chat-reachable spender with no confirm gate', () => {
    // A Sayari lookup is a READ that SPENDS — which is precisely the case a
    // single `scope` enum could not express.
    rejects([tool({ name: 'sayari_lookup_thing', spends: ['sayari'], surfaces: ['chat'] })], /must carry a confirm gate/);
  });

  it('a slow tool reachable from chat, even though it does not fan out', () => {
    // trade at 3.6–13.4 s and negativeNews at 7–15 s are both slow WITHOUT
    // fanning out — the second axis a single enum could not express.
    rejects([tool({ name: 'sayari_slow_thing', latency: 'slow', surfaces: ['chat'], spends: ['sayari'], confirm: async () => ({ what: '', spends: {}, basis: '', caveats: [] }) })], /is slow, so it may not be reachable from chat/);
  });

  it('a client-effect tool exposed anywhere but chat', () => {
    // `navigate_to` is a side effect that touches no row — the third thing a
    // single enum could not express.
    rejects([tool({ name: 'navigate_to', effect: 'client', surfaces: ['chat', 'job'] })], /surfaces must be exactly \["chat"\]/);
  });

  it('a submit_* tool reachable from chat', () => {
    // There is exactly one path into a Match or an Assessment, and it is owned
    // by a Job with a Trace.
    rejects([tool({ name: 'submit_assessment', effect: 'write', surfaces: ['chat'] })], /must have surfaces exactly \["job"\]/);
  });

  it('a write exposed over MCP that is not submit_dossier', () => {
    rejects([tool({ name: 'enqueue_over_mcp', effect: 'write', surfaces: ['mcp'] })], /only submit_dossier may be/);
  });

  it('a confirm gate on a tool no human ever sees', () => {
    rejects(
      [tool({ name: 'get_job_only', surfaces: ['job'], confirm: async () => ({ what: '', spends: {}, basis: '', caveats: [] }) })],
      /nobody would ever see it/,
    );
  });

  it('a Dossier profile whose named tool is missing', () => {
    const withoutRecord = scaffold().filter((t) => t.name !== 'sayari_get_record');
    expect(() => finalizeRegistry(withoutRecord)).toThrow(/names "sayari_get_record", which is not in the registry/);
  });

  it('a Dossier profile tool that does not carry the mcp surface', () => {
    const jobOnly = scaffold().map((t) =>
      t.name === 'sayari_get_record' ? { ...t, surfaces: ['job' as const] } : t,
    );
    expect(() => finalizeRegistry(jobOnly)).toThrow(/does not carry the mcp surface/);
  });

  it('a Match Round naming a rung that does not exist', () => {
    const withoutRung = scaffold().filter((t) => t.name !== 'join_lei');
    expect(() => finalizeRegistry(withoutRung)).toThrow(/names rung "join_lei"/);
  });

  it('and reports EVERY problem at once, not one per attempt', () => {
    try {
      finalizeRegistry([...scaffold(), tool({ name: 'bad name!' }), tool({ name: 'enqueue_x', effect: 'write', surfaces: ['chat'] })]);
      expect.unreachable();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/naming scheme/);
      expect(message).toMatch(/must carry a confirm gate/);
    }
  });
});

describe('per-surface and per-Round lists are DERIVED, never hand-written', () => {
  it('derives a surface list from the tools themselves', () => {
    const registry = finalizeRegistry(scaffold());
    const job = registry.forSurface('job');
    expect(job.every((t) => t.surfaces.includes('job'))).toBe(true);
    expect(registry.forSurface('mcp').every((t) => t.surfaces.includes('mcp'))).toBe(true);
  });

  it('offers Round 1 the R2 rung only, so calling an R3 rung first is unrepresentable', () => {
    // A fixture could only ever have proved that the RECORDED MODEL ordered its
    // rungs correctly. Deriving the list proves the code cannot offer them.
    const registry = finalizeRegistry(scaffold());
    const round1 = registry.forMatchRound(1).map((t) => t.name);
    expect(round1).toContain('find_candidates_by_name_town');
    expect(round1).not.toContain('find_candidates_by_address');
    expect(round1).not.toContain('join_lei');
  });

  it('offers Rounds 2 and 3 the three R3 rungs', () => {
    const registry = finalizeRegistry(scaffold());
    for (const round of [2, 3]) {
      const names = registry.forMatchRound(round).map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(MATCH_RUNGS_BY_ROUND[round]!));
    }
  });

  it('gives every Round the tools it needs to propose and to read an entity', () => {
    const registry = finalizeRegistry(scaffold());
    for (const round of [1, 2, 3]) {
      const names = registry.forMatchRound(round).map((t) => t.name);
      expect(names).toContain('submit_match_proposal');
      expect(names).toContain('sayari_get_entity');
    }
  });
});

describe('the tool digest', () => {
  it('is sorted by name, so two runs with the same tools share a cache', () => {
    const registry = finalizeRegistry(scaffold());
    const a = registry.digest([...registry.all]);
    const b = registry.digest([...registry.all].reverse());
    expect(a.hash).toBe(b.hash);
    expect(a.names).toEqual(b.names);
  });

  it('changes when a description changes, which is the drift a fixture hides', () => {
    // A changed tool schema is exactly the drift that leaves a fixture stale
    // while it still passes — so the hash covers descriptions, not just names.
    const registry = finalizeRegistry(scaffold());
    const before = registry.digest(registry.all).hash;
    const after = registry.digest(
      registry.all.map((t) => (t.name === 'get_supplier' ? { ...t, description: 'changed' } : t)),
    ).hash;
    expect(after).not.toBe(before);
  });
});

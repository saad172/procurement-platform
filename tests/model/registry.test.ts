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
  ...[
    'find_candidates_by_name_town',
    'find_candidates_by_address',
    'find_lei_by_name',
    'join_lei',
  ].map((name) => tool({ name, surfaces: ['job'], spends: ['sayari'] })),
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
      [
        tool({
          name: 'get_write_thing',
          effect: 'write',
          surfaces: ['chat'],
          confirm: async () => ({ what: '', spends: {}, basis: '', caveats: [] }),
        }),
      ],
      /must be named enqueue_\*/,
    );
  });

  it('a chat-reachable write with no confirm gate', () => {
    rejects(
      [tool({ name: 'enqueue_thing', effect: 'write', surfaces: ['chat'] })],
      /must carry a confirm gate/,
    );
  });

  it('a chat-reachable spender with no confirm gate', () => {
    // A Sayari lookup is a READ that SPENDS — which is precisely the case a
    // single `scope` enum could not express.
    rejects(
      [tool({ name: 'sayari_lookup_thing', spends: ['sayari'], surfaces: ['chat'] })],
      /must carry a confirm gate/,
    );
  });

  it('a slow tool reachable from chat, even though it does not fan out', () => {
    // trade at 3.6–13.4 s and negativeNews at 7–15 s are both slow WITHOUT
    // fanning out — the second axis a single enum could not express.
    rejects(
      [
        tool({
          name: 'sayari_slow_thing',
          latency: 'slow',
          surfaces: ['chat'],
          spends: ['sayari'],
          confirm: async () => ({ what: '', spends: {}, basis: '', caveats: [] }),
        }),
      ],
      /is slow, so it may not be reachable from chat/,
    );
  });

  it('a client-effect tool exposed anywhere but chat', () => {
    // `navigate_to` is a side effect that touches no row — the third thing a
    // single enum could not express.
    rejects(
      [tool({ name: 'navigate_to', effect: 'client', surfaces: ['chat', 'job'] })],
      /surfaces must be exactly \["chat"\]/,
    );
  });

  it('a submit_* tool reachable from chat', () => {
    // There is exactly one path into a Match or an Assessment, and it is owned
    // by a Job with a Trace.
    rejects(
      [tool({ name: 'submit_assessment', effect: 'write', surfaces: ['chat'] })],
      /must have surfaces exactly \["job"\]/,
    );
  });

  it('a write exposed over MCP that is not submit_dossier', () => {
    rejects(
      [tool({ name: 'enqueue_over_mcp', effect: 'write', surfaces: ['mcp'] })],
      /only submit_dossier may be/,
    );
  });

  it('a confirm gate on a tool no human ever sees', () => {
    rejects(
      [
        tool({
          name: 'get_job_only',
          surfaces: ['job'],
          confirm: async () => ({ what: '', spends: {}, basis: '', caveats: [] }),
        }),
      ],
      /nobody would ever see it/,
    );
  });

  it('a Dossier profile whose named tool is missing', () => {
    const withoutRecord = scaffold().filter((t) => t.name !== 'sayari_get_record');
    expect(() => finalizeRegistry(withoutRecord)).toThrow(
      /names "sayari_get_record", which is not in the registry/,
    );
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
      finalizeRegistry([
        ...scaffold(),
        tool({ name: 'bad name!' }),
        tool({ name: 'enqueue_x', effect: 'write', surfaces: ['chat'] }),
      ]);
      expect.unreachable();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/naming scheme/);
      expect(message).toMatch(/must carry a confirm gate/);
    }
  });
});

describe('an enqueue_* tool whose Job kind no worker runs', () => {
  /**
   * The twelfth invariant, and the only one that does not throw.
   *
   * Chat can propose `enqueue_deep_traversal` (kind `traverse`) and
   * `enqueue_dossier` (kind `dossier`), and the worker has a handler for
   * neither — so an accepted proposal produced a Job that dequeued and failed
   * with *"no handler registered"*, from a button a person deliberately
   * pressed. Refusing to boot on it would refuse to boot the application rather
   * than the mistake, so it is a **warning** until those two kinds are either
   * handled or withdrawn.
   */
  it('is reported by name, with the kind it names and the kinds that run', () => {
    const registry = finalizeRegistry([
      ...scaffold(),
      tool({
        name: 'enqueue_dreaming',
        effect: 'write',
        surfaces: ['chat'],
        enqueues: 'dossier',
        confirm: async () => ({ what: '', spends: {}, basis: '', caveats: [] }),
      }),
    ]);

    expect(registry.warnings).toHaveLength(1);
    expect(registry.warnings[0]).toContain('enqueue_dreaming');
    expect(registry.warnings[0]).toContain('dossier');
    expect(registry.warnings[0]).toContain('no worker handler runs');
  });

  it('says nothing about a tool whose kind a worker does run', () => {
    const registry = finalizeRegistry([
      ...scaffold(),
      tool({
        name: 'enqueue_working',
        effect: 'write',
        surfaces: ['chat'],
        enqueues: 'assess',
        confirm: async () => ({ what: '', spends: {}, basis: '', caveats: [] }),
      }),
    ]);
    expect(registry.warnings).toEqual([]);
  });

  it('names the two the real catalog carries, and no others', async () => {
    // The finding, kept where a reader will see it: these are the two, and the
    // list is short enough to state rather than count.
    const { getRegistry, resetRegistryForTesting } = await import('@/tools');
    resetRegistryForTesting();
    const warnings = getRegistry().warnings.join(' ');
    expect(warnings).toContain('enqueue_deep_traversal');
    expect(warnings).toContain('enqueue_dossier');
    expect(getRegistry().warnings).toHaveLength(2);
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

describe('the real catalog', () => {
  it('boots — finalizeRegistry accepts it, which is the boot check itself', async () => {
    const { getRegistry, resetRegistryForTesting } = await import('@/tools');
    resetRegistryForTesting();
    expect(() => getRegistry()).not.toThrow();
  });

  it('gives no caller the whole catalog', async () => {
    const { getRegistry } = await import('@/tools');
    const registry = getRegistry();
    const total = registry.all.length;
    for (const surface of ['chat', 'job', 'mcp'] as const) {
      expect(registry.forSurface(surface).length).toBeLessThan(total);
    }
  });

  it('exposes no write over MCP except submit_dossier', async () => {
    // One path into a Match or an Assessment, owned by a Job with a Trace.
    const { getRegistry } = await import('@/tools');
    const writes = getRegistry()
      .forSurface('mcp')
      .filter((t) => t.effect === 'write');
    expect(writes.map((t) => t.name)).toEqual(['submit_dossier']);
  });

  it('bars every slow tool from chat', async () => {
    // trade and negativeNews are slow WITHOUT fanning out, and both are barred
    // for that reason alone.
    const { getRegistry } = await import('@/tools');
    const slowOnChat = getRegistry()
      .forSurface('chat')
      .filter((t) => t.latency === 'slow');
    expect(slowOnChat).toEqual([]);
  });

  it('confirm-gates every chat tool that spends', async () => {
    const { getRegistry } = await import('@/tools');
    const ungated = getRegistry()
      .forSurface('chat')
      .filter((t) => t.spends.length > 0 && !t.confirm);
    expect(ungated.map((t) => t.name)).toEqual([]);
  });

  it('names every chat-reachable write enqueue_*', async () => {
    // Chat proposes and never does: a write it can reach enqueues the same Job
    // the page's own button would.
    const { getRegistry } = await import('@/tools');
    const writes = getRegistry()
      .forSurface('chat')
      .filter((t) => t.effect === 'write');
    expect(writes.every((t) => t.name.startsWith('enqueue_'))).toBe(true);
    expect(writes).toHaveLength(7);
  });

  it('has no tool that writes a match — the agents propose and code settles', async () => {
    const { getRegistry } = await import('@/tools');
    // submit_match_proposal and submit_match_verdict PROPOSE; there is no
    // submit_match at all, on any surface.
    expect(getRegistry().byName.has('submit_match')).toBe(false);
  });
});

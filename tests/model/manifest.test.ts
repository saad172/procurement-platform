import { describe, expect, it } from 'vitest';
import {
  LOOP_SETTINGS,
  LOOP_SYSTEMS,
  MAX_ITERATIONS_BACKSTOP,
  MAX_TOKENS,
  MODEL,
  THINKING,
  assertModelConfigIsLegal,
  buildManifest,
} from '@/model';
import { JOB_CAPS } from '@/config/constants';

/**
 * SPEC §17.3 and §17.9.
 *
 * The manifest exists so that **one test** reddens on prompt or tool drift,
 * rather than a warning appearing on every fixture. These tests assert the
 * hash actually moves when each of its four inputs moves — a hash that did not
 * would be worse than no hash, because it would look like a guarantee.
 */

describe('the settings table', () => {
  it('uses one model everywhere', () => {
    // Caches are model-scoped, the price constant stays a single pair, and the
    // fixture manifest pins one model id.
    for (const settings of Object.values(LOOP_SETTINGS)) {
      expect(settings.model).toBe(MODEL);
    }
    expect(MODEL).toBe('claude-opus-5');
  });

  it('pins the documented effort per loop', () => {
    expect(LOOP_SETTINGS.resolve.effort).toBe('high');
    expect(LOOP_SETTINGS.assess.effort).toBe('high');
    expect(LOOP_SETTINGS.recommend.effort).toBe('high');
    expect(LOOP_SETTINGS.classifier.effort).toBe('low');
    expect(LOOP_SETTINGS.chat.effort).toBe('medium');
  });

  it('streams on chat only', () => {
    expect(LOOP_SETTINGS.chat.stream).toBe(true);
    for (const [loop, settings] of Object.entries(LOOP_SETTINGS)) {
      if (loop !== 'chat') expect(settings.stream).toBe(false);
    }
  });

  it('reaches context editing to chat only, because it is in tension with replay', () => {
    // A server-side edit rewrites context mid-loop, so the prompt a replay
    // reconstructs is not the prompt that was recorded. Chat can afford
    // clearing precisely because it has no Trace.
    expect(LOOP_SETTINGS.chat.contextEditing).toBe(true);
    for (const [loop, settings] of Object.entries(LOOP_SETTINGS)) {
      if (loop !== 'chat') expect(settings.contextEditing).toBe(false);
    }
  });

  it('asks for summarized thinking, because billing is identical either way', () => {
    expect(THINKING).toEqual({ type: 'adaptive', display: 'summarized' });
  });

  it('keeps max_tokens a truncation guard, well below any cap that is a budget', () => {
    expect(MAX_TOKENS).toBe(16_000);
    // The backstop is far above our own ceilings; if it ever fires that is a bug.
    expect(MAX_ITERATIONS_BACKSTOP).toBeGreaterThan(JOB_CAPS.recommend.toolCalls);
  });
});

describe('boot validation of the model config', () => {
  it('accepts the shipped configuration', () => {
    expect(() => assertModelConfigIsLegal()).not.toThrow();
  });

  it('rejects an effort outside the legal set', () => {
    const original = LOOP_SETTINGS.chat.effort;
    try {
      (LOOP_SETTINGS.chat as { effort: string }).effort = 'turbo';
      expect(() => assertModelConfigIsLegal()).toThrow(/effort "turbo"/);
    } finally {
      LOOP_SETTINGS.chat.effort = original;
    }
  });

  it('rejects a loop with no system prompt', () => {
    const original = LOOP_SYSTEMS.chat;
    try {
      LOOP_SYSTEMS.chat = '   ';
      expect(() => assertModelConfigIsLegal()).toThrow(/empty system prompt/);
    } finally {
      LOOP_SYSTEMS.chat = original;
    }
  });
});

describe('the manifest hash', () => {
  const hashFor = (loop: string, digests: Record<string, string> = {}) =>
    buildManifest(digests)!.find((m) => m.loop === loop)!.hash;

  it('is one hash per loop', () => {
    expect(buildManifest({})).toHaveLength(Object.keys(LOOP_SETTINGS).length);
  });

  it('is stable when nothing changed', () => {
    expect(hashFor('assess')).toBe(hashFor('assess'));
  });

  it('moves when the tool digest moves', () => {
    // A changed tool schema is exactly the drift that leaves a fixture stale
    // while it still passes.
    expect(hashFor('assess', { assess: 'a' })).not.toBe(hashFor('assess', { assess: 'b' }));
  });

  it('moves when the effort moves, because effort changes the answer', () => {
    const before = hashFor('assess');
    const original = LOOP_SETTINGS.assess.effort;
    try {
      LOOP_SETTINGS.assess.effort = 'max';
      expect(hashFor('assess')).not.toBe(before);
    } finally {
      LOOP_SETTINGS.assess.effort = original;
    }
  });

  it('moves when the system prompt moves', () => {
    const before = hashFor('assess');
    const original = LOOP_SYSTEMS.assess;
    try {
      LOOP_SYSTEMS.assess = `${original}\nOne more instruction.`;
      expect(hashFor('assess')).not.toBe(before);
    } finally {
      LOOP_SYSTEMS.assess = original;
    }
  });

  it('does not collide across loops that differ only in effort', () => {
    const all = buildManifest({});
    expect(new Set(all.map((m) => m.hash)).size).toBe(all.length);
  });
});

describe('the prompts', () => {
  it('are frozen constants with no interpolation of per-run content', () => {
    // `system` is the front of the cached prefix, so a single interpolated
    // value at the top would invalidate every cached turn behind it. The only
    // interpolation allowed is of other frozen constants.
    for (const system of Object.values(LOOP_SYSTEMS)) {
      expect(system.length).toBeGreaterThan(100);
      expect(system).not.toMatch(/undefined|\[object Object\]|NaN/);
    }
  });

  // Prompts are hard-wrapped for readability, so assertions normalise
  // whitespace: the claim is about what the prompt says, not how it is laid out.
  const flat = (text: string) => text.replace(/\s+/g, ' ');

  it('quotes the Identity Standard verbatim into both Match agents', () => {
    // The same sentence reaches the resolver, the evaluator and the Needs
    // Review UI, so all three are arguing about the same thing.
    const [resolver, evaluator] = LOOP_SYSTEMS.resolve.split('---');
    const standard = 'the legal entity registered at the roster address: the contract counterparty';
    expect(flat(resolver!)).toContain(standard);
    expect(flat(evaluator!)).toContain(standard);
  });

  it('tells the evaluator it is blind, which is what makes agreement meaningful', () => {
    // Agreement is our code comparing two entity ids. An evaluator that had
    // read the resolver's pick would not be a second opinion.
    const evaluator = flat(LOOP_SYSTEMS.resolve.split('---')[1]!);
    expect(evaluator).toMatch(/not seeing anyone else's pick/i);
    expect(evaluator).toMatch(/a second opinion that has read the first is not one/i);
  });

  it('tells the classifier that `unclear` is a real answer', () => {
    expect(flat(LOOP_SYSTEMS.classifier)).toMatch(/"unclear" is a real answer/);
  });

  it('tells chat it is not the record', () => {
    expect(flat(LOOP_SYSTEMS.chat)).toMatch(/not citation-checked/);
  });
});

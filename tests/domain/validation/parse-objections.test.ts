import { describe, expect, it } from 'vitest';
import { RUBRIC_ITEMS, parseObjections } from '@/jobs/assess';

/**
 * SPEC §10.3 — reading the evaluator's rubric.
 *
 * This parse decides **whether a Round is spent**, not what is recorded: the
 * rubric text is stored verbatim on the `round` row either way. That is why it
 * has to be conservative in one specific direction — objecting to a passing
 * verdict costs a Round for nothing, and three of those publishes a version
 * carrying objections nobody raised.
 */

describe('anchored on the six item names, not on the word "fail"', () => {
  it('finds a failed item', () => {
    expect(parseObjections('support — fail: the cited row does not carry the claim')).toHaveLength(
      1,
    );
  });

  it('does NOT fire on a passing verdict that mentions failing', () => {
    // The case that motivated rewriting this: the first version searched every
    // line for /fail/ and objected on any hit.
    expect(
      parseObjections('caveats: pass — no mandatory line is missing, so this does not fail'),
    ).toEqual([]);
  });

  it('does not fire on prose that merely contains the word', () => {
    expect(parseObjections('The supplier would fail an audit on these grounds.')).toEqual([]);
  });

  it('reads markdown emphasis and list markers', () => {
    expect(parseObjections('- **number fidelity** — fail: 800 matches nothing')).toHaveLength(1);
    expect(parseObjections('2. eligibility: fail — picked without an accepted match')).toHaveLength(
      1,
    );
  });

  it('returns nothing when every item passes', () => {
    const rubric = RUBRIC_ITEMS.map((item) => `${item}: pass`).join('\n');
    expect(parseObjections(rubric)).toEqual([]);
  });

  it('returns every failed item, not just the first', () => {
    const rubric = [
      'support: pass',
      'strength: fail — a claim beyond the record',
      'number fidelity: pass',
      'caveats: fail — the tariff caveat is missing',
      'eligibility: pass',
      'omission: pass',
    ].join('\n');
    expect(parseObjections(rubric)).toHaveLength(2);
  });

  it('treats can’t-tell as not an objection', () => {
    // `unavailable` is a verdict distinct from `fail` throughout this build.
    expect(parseObjections("support: can't tell — the row was unreachable")).toEqual([]);
  });

  it('covers all six documented items', () => {
    for (const item of RUBRIC_ITEMS) {
      expect(parseObjections(`${item}: fail — something`)).toHaveLength(1);
    }
  });
});

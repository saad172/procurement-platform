import { describe, expect, it } from 'vitest';
import { disagreementObjection, entityIdsIn, type Submission } from '@/jobs/resolve-round';
import type { CapturedCall } from '@/model/tool-adapter';

/**
 * Two decisions a Match Round makes about what the agents did (SPEC §6.5,
 * §19.3) — both about the Round's own bookkeeping rather than about model
 * behaviour, so both are tested directly.
 */

const submission = (over: Partial<Submission>): Submission => ({
  entityId: null,
  verdicts: [],
  confidence: 'low',
  reasoning: 'nothing matched',
  ...over,
});

describe('every entity id the Round looked at, with the rung that surfaced it', () => {
  it('harvests ids out of a rung tool’s RESULT, which is where they arrive', () => {
    /**
     * The previous version read `call.input.entityId` — a field no rung tool
     * has. `find_candidates_by_name_town` takes a name variant and
     * `find_candidates_by_address` an address, so a Candidate a rung *returned*
     * and no agent bothered to fetch was never recorded, and never offered to
     * the person reading Needs Review.
     */
    const calls: CapturedCall[] = [
      {
        name: 'find_candidates_by_name_town',
        input: { nameVariant: 'Mahle GmbH', whyThisVariant: 'legal form' },
        output: [
          { entityId: 'from-r2-a', label: 'MAHLE GMBH' },
          { entityId: 'from-r2-b', label: 'MAHLE BEHR GMBH & CO. KG' },
        ],
      },
    ];
    expect(entityIdsIn(calls, null, null)).toEqual([
      { entityId: 'from-r2-a', rung: 'R2' },
      { entityId: 'from-r2-b', rung: 'R2' },
    ]);
  });

  it('tags each id with the rung that returned it, not the highest rung called', () => {
    const calls: CapturedCall[] = [
      { name: 'find_candidates_by_name_town', input: {}, output: [{ entityId: 'cheap' }] },
      { name: 'find_candidates_by_address', input: {}, output: [{ entityId: 'expensive' }] },
    ];
    expect(entityIdsIn(calls, null, null)).toEqual([
      { entityId: 'cheap', rung: 'R2' },
      { entityId: 'expensive', rung: 'R3a' },
    ]);
  });

  it('still reads an id the agent asked for directly, and attributes it to the pre-pass', () => {
    // `sayari_get_entity` is how an agent reads a Candidate it already has, so
    // an id seen only there came from R1.
    const calls: CapturedCall[] = [{ name: 'sayari_get_entity', input: { entityId: 'looked-up' } }];
    expect(entityIdsIn(calls, null, null)).toEqual([{ entityId: 'looked-up', rung: 'R1' }]);
  });

  it('adds the picks, and does not let a pick overwrite the rung that found it', () => {
    const calls: CapturedCall[] = [
      { name: 'find_candidates_by_address', input: {}, output: [{ entityId: 'picked' }] },
    ];
    const pick = submission({ entityId: 'picked' });
    const other = submission({ entityId: 'named-but-never-returned' });
    expect(entityIdsIn(calls, pick, other)).toEqual([
      { entityId: 'picked', rung: 'R3a' },
      { entityId: 'named-but-never-returned', rung: 'R1' },
    ]);
  });

  it('contributes nothing from the two GLEIF rungs, which return LEIs', () => {
    const calls: CapturedCall[] = [
      { name: 'join_lei', input: { lei: 'X' }, output: { lei: 'X', legalName: 'Something' } },
    ];
    expect(entityIdsIn(calls, null, null)).toEqual([]);
  });
});

describe('the objection carried into the next Round', () => {
  it('says both agents found nothing, and asks for a different rung', () => {
    /**
     * `resolver?.entityId === evaluator?.entityId` is true when both are
     * `null`, so two agents that both found nothing produced **no objection at
     * all** — and the objection is the only thing that differs between one
     * Round's prompt and the next. The next Round then got a byte-identical
     * prompt and had no reason to do anything but repeat itself.
     */
    const objection = disagreementObjection(
      submission({ entityId: null, reasoning: 'no candidate is at this address' }),
      submission({ entityId: null, reasoning: 'none of these is the roster company' }),
      1,
    );
    expect(objection).toBeDefined();
    expect(objection).toMatch(/no candidate at round 1/);
    expect(objection).toMatch(/rung you have not used yet/);
    // It proposes no answer: naming one would be the settlement arriving early.
    expect(objection).not.toMatch(/pick|choose|prefer/i);
  });

  it('still returns undefined when the two agree on a company', () => {
    const objection = disagreementObjection(
      submission({ entityId: 'same' }),
      submission({ entityId: 'same' }),
      2,
    );
    expect(objection).toBeUndefined();
  });

  it('states a disagreement in the two agents’ own words and proposes nothing', () => {
    const objection = disagreementObjection(
      submission({ entityId: 'a', reasoning: 'the LEI matches' }),
      submission({ entityId: 'b', reasoning: 'the address matches' }),
      2,
    );
    expect(objection).toMatch(/the two independent reads disagreed/i);
    expect(objection).toMatch(/the LEI matches/);
    expect(objection).toMatch(/the address matches/);
  });
});

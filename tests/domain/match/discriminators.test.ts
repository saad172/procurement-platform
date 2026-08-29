import { describe, expect, it } from 'vitest';
import {
  DISCRIMINATOR_NAMES,
  runDiscriminators,
  type CandidateFacts,
  type RosterRow,
} from '@/domain/match/discriminators';
import { evaluateAutoAccept, passesAllEight } from '@/domain/match/auto-accept';

/**
 * SPEC §6.2 and §6.3.
 *
 * **This file carries the Bosch decoy**, which SPEC §19.6 calls the most
 * instructive thing the research found: `Robert Bosch Venture Capital GmbH`
 * sits at the *exact* roster address of the row for "Bosch". Six of the eight
 * Discriminators pass on it. Two were added specifically because of it, and
 * this file is where that is demonstrated rather than asserted.
 */

/** Row 1 of the roster, verbatim. */
const BOSCH_ROW: RosterRow = {
  name: 'Bosch',
  address: 'Robert-Bosch-Platz 1 70839 Gerlingen',
  country: 'DEU',
  hasCategory: true,
};

const candidate = (overrides: Partial<CandidateFacts>): CandidateFacts => ({
  entityId: 'e1',
  label: 'ROBERT BOSCH GMBH',
  country: 'DEU',
  addresses: [{ city: 'Gerlingen', postcode: '70839', country: 'DEU' }],
  aliases: ['Bosch'],
  businessPurposes: ['Manufacture of automotive components'],
  companyType: 'Gesellschaft mit beschränkter Haftung',
  closed: false,
  latestStatus: 'active',
  lei: 'DUMMYLEI0000000000',
  gleif: { legalName: 'Robert Bosch GmbH', city: 'Gerlingen', country: 'DE' },
  ...overrides,
});

const verdictFor = (results: ReturnType<typeof runDiscriminators>, name: string) =>
  results.find((r) => r.discriminator === name)!;

describe('all eight run, always', () => {
  it('returns one verdict per discriminator, in the documented order', () => {
    const results = runDiscriminators(BOSCH_ROW, candidate({}));
    expect(results.map((r) => r.discriminator)).toEqual([...DISCRIMINATOR_NAMES]);
    expect(results).toHaveLength(8);
  });

  it('gives every verdict a line of reasoning', () => {
    for (const result of runDiscriminators(BOSCH_ROW, candidate({}))) {
      expect(result.reasoning.length).toBeGreaterThan(10);
    }
  });
});

describe('THE BOSCH DECOY — the right building holding the wrong company', () => {
  /**
   * `Robert Bosch Venture Capital GmbH` at the exact roster address. Everything
   * about its *location* is correct, which is what makes it dangerous.
   */
  const ventureCapital = candidate({
    entityId: 'decoy',
    label: 'ROBERT BOSCH VENTURE CAPITAL GMBH',
    addresses: [{ city: 'Gerlingen', postcode: '70839', country: 'DEU' }],
    businessPurposes: ['Venture capital investment in technology companies'],
    aliases: ['Robert Bosch Venture Capital'],
    lei: 'DECOYLEI000000000000',
    gleif: { legalName: 'Robert Bosch Venture Capital GmbH', city: 'Gerlingen', country: 'DE' },
  });

  it('passes every LOCATION discriminator — which is exactly the trap', () => {
    const results = runDiscriminators(BOSCH_ROW, ventureCapital);
    expect(verdictFor(results, 'country').verdict).toBe('pass');
    expect(verdictFor(results, 'locality').verdict).toBe('pass');
    expect(verdictFor(results, 'street').verdict).toBe('pass');
    expect(verdictFor(results, 'liveness').verdict).toBe('pass');
    expect(verdictFor(results, 'name_cover').verdict).toBe('pass');
  });

  it('is caught by business_purpose, and by nothing else', () => {
    // This is why the check was added mid-ticket: the original six all PASS on
    // this candidate. It is the only check that rejects a correctly-addressed
    // investment arm.
    const results = runDiscriminators(BOSCH_ROW, ventureCapital);
    const failing = results.filter((r) => r.verdict === 'fail').map((r) => r.discriminator);
    expect(failing).toEqual(['business_purpose']);
    expect(verdictFor(results, 'business_purpose').reasoning).toMatch(/right building can hold the wrong company/);
  });

  it('is therefore never auto-accepted', () => {
    const results = runDiscriminators(BOSCH_ROW, ventureCapital);
    expect(passesAllEight(results)).toBe(false);
  });

  it('and the street verdict says out loud that it is never sufficient alone', () => {
    // The one place this check is dangerous is exactly where it looks most
    // convincing, so the reasoning line carries the warning every time.
    const results = runDiscriminators(BOSCH_ROW, ventureCapital);
    expect(verdictFor(results, 'street').reasoning).toMatch(/never sufficient alone/);
  });
});

describe('an alias outlives a divestiture', () => {
  it('never PASSES on an alias hit — it is a reason to look, not to conclude', () => {
    // A divested business keeps the old group's name in alias data. Treating an
    // alias hit as agreement is how a top-hit acceptor picks a company that was
    // sold years ago.
    const divested = candidate({
      entityId: 'divested',
      label: 'SYNTEGON TECHNOLOGY GMBH',
      aliases: ['Bosch Packaging Technology', 'Bosch'],
      addresses: [{ city: 'Waiblingen', postcode: '71332', country: 'DEU' }],
    });
    const results = runDiscriminators(BOSCH_ROW, divested);
    expect(verdictFor(results, 'alias_context').verdict).toBe('unavailable');
    expect(verdictFor(results, 'alias_context').reasoning).toMatch(/outlives a divestiture/);
  });
});

describe('absence of an LEI is not evidence', () => {
  it('returns unavailable, never fail, when the record has no LEI', () => {
    const noLei = candidate({ lei: null, gleif: undefined });
    const results = runDiscriminators(BOSCH_ROW, noLei);
    expect(verdictFor(results, 'lei_witness').verdict).toBe('unavailable');
    expect(verdictFor(results, 'lei_witness').reasoning).toMatch(/not evidence against it/);
  });

  it('fails only when GLEIF actively DISAGREES about the city', () => {
    const contradicted = candidate({
      addresses: [{ city: 'Gerlingen', postcode: '70839', country: 'DEU' }],
      // Stuttgart matches neither the roster line nor any address on the record.
      gleif: { legalName: 'Robert Bosch GmbH', city: 'Stuttgart', country: 'DE' },
    });
    const results = runDiscriminators(BOSCH_ROW, contradicted);
    expect(verdictFor(results, 'lei_witness').verdict).toBe('fail');
  });
});

describe('business_purpose degrades explicitly for an uncategorised Supplier', () => {
  const uncategorised: RosterRow = { ...BOSCH_ROW, name: 'BASF', hasCategory: false };

  it('asks only "is this an operating company at all", and says so', () => {
    // Rather than passing silently, which would hide which question was asked.
    const results = runDiscriminators(uncategorised, candidate({ label: 'BASF SE' }));
    expect(verdictFor(results, 'business_purpose').reasoning).toMatch(/operating company at all/);
  });

  it('still rejects an investment arm', () => {
    const arm = candidate({ label: 'BASF VENTURE CAPITAL GMBH', businessPurposes: ['Venture capital'] });
    const results = runDiscriminators(uncategorised, arm);
    expect(verdictFor(results, 'business_purpose').verdict).toBe('fail');
  });
});

describe('liveness', () => {
  it('fails a closed company', () => {
    const results = runDiscriminators(BOSCH_ROW, candidate({ closed: true, latestStatus: 'dissolved' }));
    expect(verdictFor(results, 'liveness').verdict).toBe('fail');
  });

  it('fails a company whose status reads as dead even when the flag is not set', () => {
    const results = runDiscriminators(BOSCH_ROW, candidate({ closed: false, latestStatus: 'in liquidation' }));
    expect(verdictFor(results, 'liveness').verdict).toBe('fail');
  });

  it('returns unavailable when there is no status at all', () => {
    const results = runDiscriminators(BOSCH_ROW, candidate({ latestStatus: null }));
    expect(verdictFor(results, 'liveness').verdict).toBe('unavailable');
  });
});

describe('the auto-accept gate', () => {
  const clean = () => ({ candidate: candidate({}), verdicts: runDiscriminators(BOSCH_ROW, candidate({})) });

  it('accepts exactly one clean candidate with a GLEIF second witness', () => {
    const outcome = evaluateAutoAccept([clean()]);
    expect(outcome.accepted).toBe(true);
    if (outcome.accepted) expect(outcome.reason).toMatch(/only candidate passing all eight/);
  });

  it('REFUSES a clean candidate with no LEI — the safe direction of failure', () => {
    // Accepted consequence, stated rather than discovered: a company with no
    // LEI can never be auto-accepted. On a roster of trade names few rows clear
    // this bar, and THAT COUNT IS A RESULT TO REPORT.
    const noLei = candidate({ lei: null, gleif: undefined });
    const outcome = evaluateAutoAccept([{ candidate: noLei, verdicts: runDiscriminators(BOSCH_ROW, noLei) }]);
    expect(outcome.accepted).toBe(false);
    expect(outcome.reason).toMatch(/safe direction of failure/);
  });

  it('refuses when TWO candidates pass all eight, rather than breaking the tie', () => {
    // There is no comparable score to break it with: Sayari's `score` is not
    // comparable between queries, and matchStrength is uniform within one.
    const a = clean();
    const b = { candidate: candidate({ entityId: 'e2' }), verdicts: clean().verdicts };
    const outcome = evaluateAutoAccept([a, b]);
    expect(outcome.accepted).toBe(false);
    expect(outcome.reason).toMatch(/no comparable score to choose between them/);
  });

  it('refuses when no candidate passes all eight', () => {
    const decoy = candidate({ businessPurposes: ['Venture capital'] });
    const outcome = evaluateAutoAccept([{ candidate: decoy, verdicts: runDiscriminators(BOSCH_ROW, decoy) }]);
    expect(outcome.accepted).toBe(false);
    expect(outcome.reason).toMatch(/No candidate passed all eight/);
  });

  it('treats `unavailable` as NOT a pass', () => {
    // Eight passes means eight passes. An unavailable verdict is missing
    // evidence, and missing evidence cannot clear a gate.
    const results = runDiscriminators(BOSCH_ROW, candidate({ latestStatus: null }));
    expect(passesAllEight(results)).toBe(false);
  });
});

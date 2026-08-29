import { describe, expect, it } from 'vitest';
import { candidatesFrom, checkNumberFidelity } from '@/domain/validation/number-fidelity';

/**
 * SPEC §10.4, check 2 — one of the nine unit tests §19.6 asks for.
 *
 * The examples in the spec are the test cases: *48 matches 47.6; 71.3 matches
 * 71.28; `2.5%` matches `2.5` or `0.025`; **paraphrase fails** — "roughly
 * 800 km" has no candidate.*
 */

const candidates = candidatesFrom(
  {
    weights: { compliance_risk: 28 },
    scores: { 'supplier-a': 71.28 },
  },
  [
    { km: 47.6, hsCode: '8544.30', mfnRate: '5.000', fetchedAt: '2026-08-19T00:00:00.000Z' },
    { distance: 824, lei: 'W38RGI023J3WT1HWRP32' },
  ],
);

describe('rounded to the decimals the sentence itself used', () => {
  it('accepts 48 against a stored 47.6', () => {
    expect(checkNumberFidelity('It is 48 km from the nearest plant.', candidates)).toEqual([]);
  });

  it('accepts 71.3 against a stored 71.28', () => {
    expect(checkNumberFidelity('Its score is 71.3.', candidates)).toEqual([]);
  });

  it('accepts the stored value written in full', () => {
    expect(checkNumberFidelity('It is 47.6 km away.', candidates)).toEqual([]);
  });

  it('rejects a figure at a precision the evidence does not support', () => {
    // 47.61 is not 47.6 at two decimals, so it is a claim the rows do not carry.
    const failures = checkNumberFidelity('It is 47.61 km away.', candidates);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.token).toBe('47.61');
  });
});

describe('PARAPHRASE FAILS — which is the point of the rule', () => {
  it('rejects "roughly 800 km" against a stored 824', () => {
    // 800 is not 824 at any precision. This is the case the whole check exists
    // for: a rounded-for-readability figure is a number the evidence does not
    // contain.
    const failures = checkNumberFidelity('It is roughly 800 km away.', candidates);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.token).toBe('800');
  });

  it('accepts the real 824', () => {
    expect(checkNumberFidelity('It is 824 km away.', candidates)).toEqual([]);
  });

  it('NAMES the unmatched token, because "a number is wrong" is not actionable', () => {
    const failures = checkNumberFidelity('Its score is 88.4.', candidates);
    expect(failures[0]!.message).toContain('88.4');
    expect(failures[0]!.message).toMatch(/cite the row that carries it/);
  });

  it('reports every failure rather than the first', () => {
    // A Round spent on a rejection should fix everything it can.
    const failures = checkNumberFidelity('It is 800 km away and scores 88.4.', candidates);
    expect(failures.map((f) => f.token).sort()).toEqual(['800', '88.4']);
  });
});

describe('percentages match either form', () => {
  it('accepts 5% against a stored "5.000"', () => {
    // `numeric` columns round-trip as strings through postgres.js, so the
    // stored rate is the string "5.000" and must still match.
    expect(checkNumberFidelity('The MFN rate is 5%.', candidates)).toEqual([]);
  });

  it('accepts 2.5% against a stored decimal fraction 0.025', () => {
    const c = candidatesFrom({}, [{ rate: 0.025 }]);
    expect(checkNumberFidelity('The rate is 2.5%.', c)).toEqual([]);
  });

  it('rejects a percentage the evidence does not carry', () => {
    const failures = checkNumberFidelity('The MFN rate is 7%.', candidates);
    expect(failures).toHaveLength(1);
  });
});

describe('identifiers match as STRINGS, never as numbers', () => {
  it('accepts an HS code that appears on a cited row', () => {
    expect(checkNumberFidelity('It falls under HS 8544.30.', candidates)).toEqual([]);
  });

  it('does not decompose an HS code into two numbers', () => {
    // 8544 and 30 are not separately claimed, and treating them as numbers
    // would demand evidence for figures nobody wrote.
    const failures = checkNumberFidelity('It falls under HS 8544.30.', candidates);
    expect(failures).toEqual([]);
  });

  it('rejects an HS code that appears nowhere', () => {
    const failures = checkNumberFidelity('It falls under HS 8708.99.', candidates);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.kind).toBe('identifier');
  });

  it('accepts an LEI that appears on a cited row', () => {
    expect(checkNumberFidelity('Its LEI is W38RGI023J3WT1HWRP32.', candidates)).toEqual([]);
  });
});

describe('dates match exact to the day', () => {
  it('accepts a date that matches a fetched_at', () => {
    expect(checkNumberFidelity('Fetched on 2026-08-19.', candidates)).toEqual([]);
  });

  it('rejects a date no cited row carries', () => {
    const failures = checkNumberFidelity('Fetched on 2026-01-01.', candidates);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.kind).toBe('date');
  });
});

describe('small numbers inside prose are language, not claims', () => {
  it('does not demand evidence for "one of three"', () => {
    // Firing on grammar would make the validator unusable and would teach the
    // model to avoid ordinary English.
    expect(checkNumberFidelity('It is one of 3 bidders in this category.', candidates)).toEqual([]);
  });

  it('still checks a figure written with a decimal, however small', () => {
    const failures = checkNumberFidelity('It scores 3.7.', candidates);
    expect(failures).toHaveLength(1);
  });
});

describe('numbers inside a cited PROSE field are stored numbers too', () => {
  // The case that forced this: every criterion_value carries an anchorLine that
  // the app itself writes — "starts at 100; high −40, elevated −20" — and which
  // the UI renders beside every value. A sentence explaining a score by quoting
  // its own scale is quoting the evidence it cites. Rejecting that taught the
  // model to describe a scale without naming it: worse prose, no more honest.
  const withAnchor = candidatesFrom({}, [
    { value: 92, anchorLine: 'starts at 100; high −40, elevated −20, relevant −8, floored at 0' },
  ]);

  it('accepts a sentence that quotes its own anchor line', () => {
    expect(
      checkNumberFidelity(
        'Compliance risk scored 92 on a scale that starts at 100 and deducts 40 for high and 20 for elevated.',
        withAnchor,
      ),
    ).toEqual([]);
  });

  it('accepts a figure inside a cited address', () => {
    const withAddress = candidatesFrom({}, [{ addressLine: 'W Building, 8-15 Konan 1-chome, Tokyo 108-0075' }]);
    expect(checkNumberFidelity('It is registered at Tokyo 108-0075.', withAddress)).toEqual([]);
  });

  it('does NOT decompose an identifier into loose digits', () => {
    // An LEI and an HS code contain digits but are not a source of numbers.
    // Restricting extraction to strings containing whitespace is what keeps
    // "roughly 800 km" failing, which is the case the whole check exists for.
    const withIdentifiers = candidatesFrom({}, [
      { lei: 'W38RGI023J3WT1HWRP32', hsCode: '8544.30', distance: 824 },
    ]);
    expect(checkNumberFidelity('It is roughly 800 km away.', withIdentifiers)).toHaveLength(1);
    expect(checkNumberFidelity('It scores 38.4.', withIdentifiers)).toHaveLength(1);
  });
});

describe('candidate scoping', () => {
  it('draws candidates from the frozen inputs as well as the cited rows', () => {
    expect(checkNumberFidelity('The compliance weight is 28.', candidates)).toEqual([]);
  });

  it('scopes candidates PER SENTENCE, so a sentence cannot borrow evidence it did not cite', () => {
    const narrow = candidatesFrom({}, [{ km: 47.6 }]);
    // 824 exists on another row, but this sentence did not cite it.
    expect(checkNumberFidelity('It is 824 km away.', narrow)).toHaveLength(1);
  });

  it('handles thousands separators', () => {
    const c = candidatesFrom({}, [{ nodes: 2275 }]);
    expect(checkNumberFidelity('2,275 members were reachable.', c)).toEqual([]);
  });
});

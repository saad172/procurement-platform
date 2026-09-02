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

  it('states the rule the check actually applies, rounding included', () => {
    const failures = checkNumberFidelity('Its score is 88.4.', candidates);
    expect(failures[0]!.message).toMatch(
      /must appear in the frozen inputs or on a row this sentence cites, rounded to the decimals you wrote/,
    );
  });

  it('names nothing when no stored value is near', () => {
    // 88.4 is 24% away from the nearest candidate (71.28). Naming that would
    // invite the model to write a figure it never had evidence for.
    const failures = checkNumberFidelity('Its score is 88.4.', candidates);
    expect(failures[0]!.message).not.toMatch(/nearest stored value/);
  });

  it('names the nearest stored value when the figure is one rounding away', () => {
    // Finding 152: three Rounds were spent on a figure the objection could
    // have pointed at.
    const failures = checkNumberFidelity('It is 47.61 km away.', candidates);
    expect(failures[0]!.message).toMatch(/the nearest stored value is 47\.6/);
  });

  it('names the nearest stored value for a paraphrased figure too', () => {
    const failures = checkNumberFidelity('It is roughly 800 km away.', candidates);
    expect(failures[0]!.message).toMatch(/the nearest stored value is 824/);
  });

  it('measures a percentage against both readings of a candidate', () => {
    // A stored 0.025 is 2.5%, so a written 2.6% is one rounding away from it
    // and the objection says so rather than leaving the model to guess.
    const failures = checkNumberFidelity('The rate is 2.6%.', candidatesFrom({}, [{ r: 0.025 }]));
    expect(failures[0]!.message).toMatch(/the nearest stored value is 0\.025/);
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

  it('does NOT read an ordinary hyphenated word as an entity id', () => {
    // Measured: "state-owned-enterprise" is exactly 22 characters of letters
    // and hyphens, and a bare {22} length check rejected it as an unresolvable
    // entity id — a validator objecting to a word. Real Sayari ids mix cases
    // with digits, so all three classes are required.
    expect(
      checkNumberFidelity('A state-owned-enterprise finding sits on the family.', candidates),
    ).toEqual([]);
    expect(checkNumberFidelity('It is a forced-labour-reporting entity here.', candidates)).toEqual(
      [],
    );
  });

  it('still reads a real Sayari entity id as an identifier', () => {
    const withEntity = candidatesFrom({}, [{ entityId: 'LAtrDml3ulKGjNIIFGSNAg' }]);
    expect(checkNumberFidelity('The profile is LAtrDml3ulKGjNIIFGSNAg.', withEntity)).toEqual([]);
    expect(checkNumberFidelity('The profile is bryNuZ2GwwXGB74Rm75-Zw.', withEntity)).toHaveLength(
      1,
    );
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
    const withAddress = candidatesFrom({}, [
      { addressLine: 'W Building, 8-15 Konan 1-chome, Tokyo 108-0075' },
    ]);
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

/**
 * A hyphenated token is not a figure.
 *
 * The Japanese postcode `108-8333` was read from the left as the number 108,
 * which appears in no frozen input — and an otherwise correct Assessment was
 * rejected in all three Rounds because of it.
 */
describe('hyphenated tokens', () => {
  const noEvidence = { frozenInputs: {}, citedRows: [] };

  it('does not read a postcode as a number', () => {
    const failures = checkNumberFidelity(
      'The postcode 108-8333 on the matched entity is the same postcode as the roster row.',
      candidatesFrom(noEvidence.frozenInputs, noEvidence.citedRows),
    );
    expect(failures).toEqual([]);
  });

  it('does not read a Japanese street number as three numbers', () => {
    const failures = checkNumberFidelity(
      'It is registered at 1-8-15, Konan, Minato-ku.',
      candidatesFrom(noEvidence.frozenInputs, noEvidence.citedRows),
    );
    expect(failures).toEqual([]);
  });

  it('still catches an invented figure beside one', () => {
    // The guard must not become a way to smuggle numbers past the check.
    const failures = checkNumberFidelity(
      'The postcode 108-8333 sits in a city of 37 million people.',
      candidatesFrom(noEvidence.frozenInputs, noEvidence.citedRows),
    );
    expect(failures.map((f) => f.token)).toContain('37');
  });

  it('still reads an en-dash range as the numbers it contains', () => {
    // The app writes its own anchor lines with en dashes, and a sentence
    // quoting one is quoting evidence.
    const failures = checkNumberFidelity(
      'Proximity runs 0–8000 km.',
      candidatesFrom({ anchor: 'runs 0 to 8000 km' }, []),
    );
    expect(failures).toEqual([]);
  });
});

/**
 * A digit run glued to a letter is not a figure.
 *
 * Measured on a live Assessment Job (run 022cd220, Magna International): the
 * brief handed the model a Category uuid, and the sentence "In category
 * 96c09ae3-9f90-5f8a-9652-b8ca56fc1cc4 the supplier…" was rejected because
 * *96* appears in no frozen input. Three Rounds went on it and the Job was
 * terminated.
 */
describe('digits glued to letters', () => {
  const noEvidence = candidatesFrom({}, []);

  it('does not read the leading group of a uuid as a number', () => {
    // The uuid is one the brief handed the model. An identifier fragment is
    // not a claim about a quantity, so there is nothing here to verify.
    expect(
      checkNumberFidelity(
        'In category 96c09ae3-9f90-5f8a-9652-b8ca56fc1cc4 the supplier bids on housings.',
        noEvidence,
      ),
    ).toEqual([]);
  });

  it('does not read an ordinal as a number', () => {
    expect(checkNumberFidelity('It ranks 10th on the shortlist.', noEvidence)).toEqual([]);
    expect(checkNumberFidelity('It is the 3rd source in this category.', noEvidence)).toEqual([]);
  });

  it('still reads a figure written before its unit', () => {
    const c = candidatesFrom({}, [{ km: 6815 }]);
    expect(checkNumberFidelity('It is 6815 km from the nearest plant.', c)).toEqual([]);
    expect(
      checkNumberFidelity('It is 6915 km from the nearest plant.', c).map((f) => f.token),
    ).toEqual(['6915']);
  });

  it('still reads a percentage and a thousands-separated figure', () => {
    const c = candidatesFrom({}, [{ rate: 2.5, members: 48033 }]);
    expect(checkNumberFidelity('The rate is 2.5% across 48,033 members.', c)).toEqual([]);
    expect(
      checkNumberFidelity('The rate is 3.5% across 48,034 members.', c)
        .map((f) => f.token)
        .sort(),
    ).toEqual(['3.5%', '48,034']);
  });
});

/**
 * A figure copied exactly as stored must not be refused.
 *
 * Measured on a live Assessment (Faurecia, twice): the model wrote the
 * proximity Criterion's value as `20.190218190717246` — the stored value,
 * digit for digit — and the check rejected it, because rounding a float and
 * comparing with `===` does not survive fifteen decimals. The objection asked
 * the model to write the figure as it is stored, and then refused the figure as
 * it is stored.
 */
describe('a figure written exactly as stored', () => {
  const stored = candidatesFrom({}, [{ proximity: 20.190218190717246 }]);

  it('accepts the full stored value, all fifteen decimals of it', () => {
    expect(checkNumberFidelity('Proximity scores 20.190218190717246.', stored)).toEqual([]);
  });

  it('accepts the same value written shorter', () => {
    expect(checkNumberFidelity('Proximity scores 20.19.', stored)).toEqual([]);
    expect(checkNumberFidelity('Proximity scores 20.190218.', stored)).toEqual([]);
  });

  it('accepts a figure rounded to the decimals the sentence used', () => {
    expect(checkNumberFidelity('Proximity scores 20.2.', stored)).toEqual([]);
  });

  it('still rejects a figure the rounding does not reach', () => {
    // 20.3 is not 20.19… at one decimal, so it is a claim the row does not
    // carry. Tolerating representation must not tolerate paraphrase.
    const failures = checkNumberFidelity('Proximity scores 20.3.', stored);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.token).toBe('20.3');
  });

  it('accepts a percentage at full precision against its stored fraction', () => {
    const fraction = candidatesFrom({}, [{ share: 0.20190218190717246 }]);
    expect(
      checkNumberFidelity('It carries 20.190218190717246% of the shipments.', fraction),
    ).toEqual([]);
    expect(
      checkNumberFidelity('It carries 21.190218190717246% of the shipments.', fraction),
    ).toHaveLength(1);
  });
});

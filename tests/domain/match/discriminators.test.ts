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
  addresses: [
    {
      city: 'Gerlingen',
      postcode: '70839',
      country: 'DEU',
      line: 'Robert-Bosch-Platz 1, 70839 Gerlingen, DE',
    },
  ],
  aliases: ['Bosch'],
  businessPurposes: ['Manufacture of automotive components'],
  companyType: 'Gesellschaft mit beschränkter Haftung',
  closed: false,
  latestStatus: 'active',
  lei: 'DUMMYLEI0000000000',
  gleif: {
    legalName: 'Robert Bosch GmbH',
    jurisdiction: 'DE',
    legalCity: 'Gerlingen',
    legalCountry: 'DE',
    hqCity: 'Gerlingen',
  },
  // Robert Bosch GmbH is owned by the Robert Bosch Stiftung, and that is the
  // ownership hop working rather than an ambiguity — see `name_cover`.
  owners: [{ entityId: 'stiftung', label: 'Robert Bosch Stiftung GmbH' }],
  relationshipsTruncated: false,
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
    addresses: [
      {
        city: 'Gerlingen',
        postcode: '70839',
        country: 'DEU',
        line: 'Robert-Bosch-Platz 1, 70839 Gerlingen, DE',
      },
    ],
    businessPurposes: ['Venture capital investment in technology companies'],
    aliases: ['Robert Bosch Venture Capital'],
    lei: 'DECOYLEI000000000000',
    gleif: {
      legalName: 'Robert Bosch Venture Capital GmbH',
      jurisdiction: 'DE',
      legalCity: 'Gerlingen',
      legalCountry: 'DE',
      hqCity: 'Gerlingen',
    },
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
    expect(verdictFor(results, 'business_purpose').reasoning).toMatch(
      /right building can hold the wrong company/,
    );
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
      addresses: [
        {
          city: 'Waiblingen',
          postcode: '71332',
          country: 'DEU',
          line: 'Stuttgarter Strasse 130, 71332 Waiblingen, DE',
        },
      ],
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

  it('fails when GLEIF places the LEI in a city the ROSTER does not name', () => {
    const contradicted = candidate({
      // Gerlingen is on the Sayari record, and that is now beside the point:
      // GLEIF corroborates the roster or it corroborates nothing.
      gleif: {
        legalName: 'Robert Bosch GmbH',
        jurisdiction: 'DE',
        legalCity: 'Stuttgart',
        legalCountry: 'DE',
        hqCity: 'Stuttgart',
      },
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
    const arm = candidate({
      label: 'BASF VENTURE CAPITAL GMBH',
      businessPurposes: ['Venture capital'],
    });
    const results = runDiscriminators(uncategorised, arm);
    expect(verdictFor(results, 'business_purpose').verdict).toBe('fail');
  });
});

describe('liveness', () => {
  it('fails a closed company', () => {
    const results = runDiscriminators(
      BOSCH_ROW,
      candidate({ closed: true, latestStatus: 'dissolved' }),
    );
    expect(verdictFor(results, 'liveness').verdict).toBe('fail');
  });

  it('fails a company whose status reads as dead even when the flag is not set', () => {
    const results = runDiscriminators(
      BOSCH_ROW,
      candidate({ closed: false, latestStatus: 'in liquidation' }),
    );
    expect(verdictFor(results, 'liveness').verdict).toBe('fail');
  });

  it('returns unavailable when there is no status at all', () => {
    const results = runDiscriminators(BOSCH_ROW, candidate({ latestStatus: null }));
    expect(verdictFor(results, 'liveness').verdict).toBe('unavailable');
  });
});

describe('the auto-accept gate', () => {
  const clean = () => ({
    candidate: candidate({}),
    verdicts: runDiscriminators(BOSCH_ROW, candidate({})),
  });

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
    const outcome = evaluateAutoAccept([
      { candidate: noLei, verdicts: runDiscriminators(BOSCH_ROW, noLei) },
    ]);
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
    const outcome = evaluateAutoAccept([
      { candidate: decoy, verdicts: runDiscriminators(BOSCH_ROW, decoy) },
    ]);
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

/**
 * **The LEI witness corroborates the ROSTER, on jurisdiction and city.**
 *
 * Finding 13 got the direction right and left a second clause behind: pass when
 * GLEIF's city matches any address on the *Sayari* record. That clause proves
 * the LEI belongs to the record — which the exact-LEI join has already
 * established — and proves nothing about the roster. Every one of the four
 * Matches this build settled by rules onto a subsidiary passed the witness
 * through it.
 */
describe('the LEI witness, on jurisdiction and city', () => {
  const AAM_ROW: RosterRow = {
    name: 'American Axle & Manufacturing',
    address: 'One Dauch Drive Detroit MI 48211',
    country: 'USA',
    hasCategory: true,
  };

  const aam = (overrides: Partial<CandidateFacts>): CandidateFacts =>
    candidate({
      label: 'AMERICAN AXLE & MANUFACTURING INC',
      country: 'USA',
      addresses: [
        {
          city: 'Detroit',
          postcode: '48211',
          country: 'USA',
          line: 'ONE DAUCH DRIVE, DETROIT MI 48211-1198',
        },
      ],
      aliases: ['American Axle'],
      lei: 'RY5TAKFOBLDUGX31MS24',
      gleif: {
        legalName: 'AMERICAN AXLE & MANUFACTURING, INC.',
        jurisdiction: 'US-DE',
        legalCity: 'WILMINGTON',
        legalCountry: 'US',
        hqCity: 'DETROIT',
      },
      owners: [],
      ...overrides,
    });

  it('passes on the HEADQUARTERS city when the legal one is a Delaware address', () => {
    // Measured: GLEIF puts this LEI's legal address in Wilmington and its
    // headquarters in Detroit. The roster says Detroit. Reading only the legal
    // address rejected the right company for being incorporated in Delaware.
    const results = runDiscriminators(AAM_ROW, aam({}));
    expect(verdictFor(results, 'lei_witness').verdict).toBe('pass');
    expect(verdictFor(results, 'lei_witness').reasoning).toMatch(/headquarters in DETROIT/);
  });

  it('fails on the JURISDICTION, whatever addresses the record files', () => {
    // GLEIF lists the Thai company's headquarters as Detroit — the parent's —
    // so the city agrees and only the jurisdiction separates them.
    const thai = aam({
      label: 'American Axle & Manufacturing (Thailand) Co., Ltd.',
      country: 'THA',
      lei: '549300I3T45HQPO9XB09',
      gleif: {
        legalName: 'บริษัท อเมริกัน แอ็คเซิล แอนด์ แมนูแฟคเจอริ่ง (ประเทศไทย) จำกัด',
        jurisdiction: 'TH',
        legalCity: 'RAYONG',
        legalCountry: 'TH',
        hqCity: 'DETROIT',
      },
    });
    const witness = verdictFor(runDiscriminators(AAM_ROW, thai), 'lei_witness');
    expect(witness.verdict).toBe('fail');
    expect(witness.reasoning).toMatch(/Thailand/);
    expect(witness.reasoning).toMatch(/United States/);
  });

  it('reads US-DE as the United States, not as a country of its own', () => {
    expect(verdictFor(runDiscriminators(AAM_ROW, aam({})), 'lei_witness').verdict).toBe('pass');
  });

  it('no longer passes merely because GLEIF agrees with SAYARI', () => {
    // The removed fallback. Sayari and GLEIF both say Rayong; the roster says
    // Detroit; the LEI is registered in Thailand. Two witnesses agreeing with
    // each other is not a witness on the roster's claim.
    const thaiOnly = aam({
      country: 'THA',
      addresses: [
        { city: 'RAYONG', postcode: '21140', country: 'THA', line: '500/52 MU 3 TA SIT, TH' },
      ],
      lei: '549300I3T45HQPO9XB09',
      gleif: {
        legalName: 'AAM (Thailand)',
        jurisdiction: 'TH',
        legalCity: 'RAYONG',
        legalCountry: 'TH',
        hqCity: 'RAYONG',
      },
    });
    expect(verdictFor(runDiscriminators(AAM_ROW, thaiOnly), 'lei_witness').verdict).toBe('fail');
  });

  it("returns unavailable when GLEIF's cities are in a script this build cannot read", () => {
    // Sumitomo Electric's own LEI record: jurisdiction JP, both cities in
    // Japanese. That is a witness that said nothing, not a witness that
    // disagreed — and `unavailable` is not a pass, so it cannot auto-accept.
    const sumitomo = aam({
      label: 'SUMITOMO ELECTRIC INDUSTRIES,LTD',
      lei: '5493005SP87FL5TOS202',
      gleif: {
        legalName: '住友電気工業株式会社',
        jurisdiction: 'JP',
        legalCity: '大阪府 大阪市中央区',
        legalCountry: 'JP',
        hqCity: '大阪府 大阪市中央区',
      },
    });
    const row: RosterRow = {
      name: 'Sumitomo Electric',
      address: '5-33 Kitahama 4-chome Chuo-ku Osaka 541-0041',
      country: 'JPN',
      hasCategory: true,
    };
    const witness = verdictFor(runDiscriminators(row, sumitomo), 'lei_witness');
    expect(witness.verdict).toBe('unavailable');
    expect(witness.reasoning).toMatch(/no city this comparison can read/);
  });

  it('returns unavailable when GLEIF records no jurisdiction at all', () => {
    const noJurisdiction = aam({
      gleif: {
        legalName: 'AMERICAN AXLE & MANUFACTURING, INC.',
        jurisdiction: null,
        legalCity: 'DETROIT',
        legalCountry: 'US',
        hqCity: 'DETROIT',
      },
    });
    expect(verdictFor(runDiscriminators(AAM_ROW, noJurisdiction), 'lei_witness').verdict).toBe(
      'unavailable',
    );
  });
});

/**
 * **`name_cover` reads the surplus too** — the words the Candidate has and the
 * roster does not.
 *
 * Cover is one-sided, and the missing side is where a corporate family lives:
 * every member of it contains the parent's name. Three of the four Matches
 * settled by rules onto a subsidiary passed this check.
 */
describe('name_cover reads what the candidate ADDS', () => {
  const AAM_ROW: RosterRow = {
    name: 'American Axle & Manufacturing',
    address: 'One Dauch Drive Detroit MI 48211',
    country: 'USA',
    hasCategory: true,
  };

  it('passes when the names are the same company and nothing else', () => {
    const exact = candidate({ label: 'AMERICAN AXLE & MANUFACTURING INC', owners: [] });
    expect(verdictFor(runDiscriminators(AAM_ROW, exact), 'name_cover').verdict).toBe('pass');
  });

  it('returns unavailable on a parenthesised aside — "(Thailand)"', () => {
    const thai = candidate({
      label: 'American Axle & Manufacturing (Thailand) Co., Ltd.',
      owners: [],
    });
    const cover = verdictFor(runDiscriminators(AAM_ROW, thai), 'name_cover');
    expect(cover.verdict).toBe('unavailable');
    expect(cover.reasoning).toMatch(/\(Thailand\)/);
  });

  it('returns unavailable on a bare number — Gestamp 2020 SL', () => {
    const gestamp2020 = candidate({ label: 'GESTAMP 2020 SL', owners: [] });
    const row: RosterRow = { ...AAM_ROW, name: 'Gestamp' };
    const cover = verdictFor(runDiscriminators(row, gestamp2020), 'name_cover');
    expect(cover.verdict).toBe('unavailable');
    expect(cover.reasoning).toMatch(/"2020"/);
  });

  it('returns unavailable on a country word, parenthesised or not', () => {
    const mexico = candidate({
      label: 'AMERICAN AXLE & MANUFACTURING DE MEXICO S DE R.L. DE C.V.',
      owners: [],
    });
    const cover = verdictFor(runDiscriminators(AAM_ROW, mexico), 'name_cover');
    expect(cover.verdict).toBe('unavailable');
    expect(cover.reasoning).toMatch(/"mexico"/);
  });

  it('returns unavailable when a current owner answers to the roster name too', () => {
    // MAHLE BEHR GMBH & CO. KG is owned by MAHLE GmbH, and "Mahle" names both.
    const behr = candidate({
      label: 'MAHLE BEHR GMBH & CO. KG',
      owners: [{ entityId: 'mahle', label: 'MAHLE GmbH' }],
    });
    const row: RosterRow = { ...AAM_ROW, name: 'Mahle' };
    const cover = verdictFor(runDiscriminators(row, behr), 'name_cover');
    expect(cover.verdict).toBe('unavailable');
    expect(cover.reasoning).toMatch(/MAHLE GmbH/);
  });

  it('still PASSES Robert Bosch GmbH, whose owner is a foundation', () => {
    // The ownership hop working, not an ambiguity: a Stiftung holding a
    // manufacturer is not a second company competing for the roster row. The
    // exclusion list is `business_purpose`'s, reused rather than copied.
    const cover = verdictFor(runDiscriminators(BOSCH_ROW, candidate({})), 'name_cover');
    expect(cover.verdict).toBe('pass');
  });

  it('still PASSES the plain-surplus names the roster’s right answers carry', () => {
    // Measured: these four are correct Matches whose legal name is simply
    // fuller than the trade name on the list.
    const cases: [string, string][] = [
      ['Sumitomo Electric', 'SUMITOMO ELECTRIC INDUSTRIES,LTD'],
      ['Plastic Omnium', 'COMPAGNIE PLASTIC OMNIUM'],
      ['Grupo Antolin', 'Grupo Antolin Irausa SA'],
      ['Toyoda Gosei', 'TOYODA GOSEI COMPANY LIMITED'],
    ];
    for (const [rosterName, label] of cases) {
      const row: RosterRow = { ...AAM_ROW, name: rosterName };
      const cover = verdictFor(
        runDiscriminators(row, candidate({ label, owners: [] })),
        'name_cover',
      );
      expect(cover.verdict, `${rosterName} → ${label}`).toBe('pass');
    }
  });

  it('says so when the relationship window was truncated', () => {
    // An owner absent from a truncated window is not an absent owner.
    const truncated = candidate({
      label: 'SAMVARDHANA MOTHERSON ADSYS TECH LIMITED',
      owners: [],
      relationshipsTruncated: true,
    });
    const row: RosterRow = { ...AAM_ROW, name: 'Samvardhana Motherson' };
    const cover = verdictFor(runDiscriminators(row, truncated), 'name_cover');
    expect(cover.verdict).toBe('pass');
    expect(cover.reasoning).toMatch(/window is not complete/);
  });

  it('returns unavailable, never fail, on a label it cannot read', () => {
    // The Sayari record carrying MAHLE GmbH's own LEI is labelled 马勒有限公司.
    const chinese = candidate({ label: '马勒有限公司', aliases: ['马勒'], owners: [] });
    const row: RosterRow = { ...AAM_ROW, name: 'Mahle' };
    const results = runDiscriminators(row, chinese);
    expect(verdictFor(results, 'name_cover').verdict).toBe('unavailable');
    expect(verdictFor(results, 'alias_context').verdict).toBe('unavailable');
  });
});

/**
 * **The gate refuses when a rival is free of a `fail`** (SPEC §6.3).
 *
 * `unavailable` is not a `fail`, so "exactly one candidate passed all eight" is
 * a weaker claim than it reads as: a rival can lose on a missing status field
 * rather than on anything about its identity.
 */
describe('the gate refuses when nothing rules the rival out', () => {
  const SM_ROW: RosterRow = {
    name: 'Samvardhana Motherson',
    address: 'Plot No. 1 Sector 127 Noida-Greater Noida Expressway Noida 201301',
    country: 'IND',
    hasCategory: true,
  };

  const noida = (overrides: Partial<CandidateFacts>): CandidateFacts =>
    candidate({
      country: 'IND',
      addresses: [
        {
          city: 'Noida',
          postcode: '201301',
          country: 'IND',
          line: 'Plot No. 1, Sector 127, Noida-, Greater Noida Express Way',
        },
      ],
      aliases: [],
      businessPurposes: ['Manufacture of electronic components'],
      companyType: 'LTD',
      lei: '335800LR8AATHVNSZF36',
      gleif: {
        legalName: 'SAMVARDHANA MOTHERSON ADSYS TECH LIMITED',
        jurisdiction: 'IN',
        legalCity: 'Noida',
        legalCountry: 'IN',
        hqCity: 'Noida',
      },
      owners: [],
      ...overrides,
    });

  it('refuses the clean winner when a rival failed nothing either', () => {
    // The measured shape: ADSYS was the only all-eight pass, and Samvardhana
    // Motherson International Ltd. — at the roster's own address — lost it on
    // one `unavailable` liveness verdict. The gate settled on the smaller
    // company without anything ever ruling the larger one out.
    const adsys = noida({ entityId: 'adsys', label: 'SAMVARDHANA MOTHERSON ADSYS TECH LIMITED' });
    const international = noida({
      entityId: 'international',
      label: 'Samvardhana Motherson International Ltd.',
      // No status at all: `liveness` is `unavailable`, which is not a pass and
      // is also not a reason to reject it.
      latestStatus: null,
    });

    const assessments = [adsys, international].map((c) => ({
      candidate: c,
      verdicts: runDiscriminators(SM_ROW, c),
    }));
    expect(passesAllEight(assessments[0]!.verdicts)).toBe(true);
    expect(passesAllEight(assessments[1]!.verdicts)).toBe(false);
    expect(assessments[1]!.verdicts.some((v) => v.verdict === 'fail')).toBe(false);

    const outcome = evaluateAutoAccept(assessments);
    expect(outcome.accepted).toBe(false);
    expect(outcome.reason).toMatch(/Samvardhana Motherson International Ltd\./);
    expect(outcome.reason).toMatch(/failed none of them either/);
    // The refusal names WHICH checks placed the rival, so a reader can see the
    // claim rather than take the refusal on trust.
    expect(outcome.reason).toMatch(/country, locality, street/);
  });

  it('does NOT count a rival that nothing places at the roster address', () => {
    /**
     * **A rival needs zero `fail` verdicts *and* something placing it at the
     * roster address** — one of `country`, `locality`, `street` or
     * `lei_witness` returning `pass`.
     *
     * The second half is the Identity Standard rather than a convenience: the
     * right answer is *the legal entity registered at the roster address*, so a
     * record that says nothing about where it is has not made a competing claim
     * to be that entity. It is a record with no evidence, not a candidate with
     * contrary evidence.
     */
    const unplaced = candidate({
      entityId: 'unplaced',
      label: 'ROBERT BOSCH',
      country: null,
      // No country, no city, no postcode, no line: nothing to place it.
      addresses: [{ city: null, postcode: null, country: null, line: null }],
      aliases: ['Bosch'],
      lei: null,
      gleif: undefined,
      latestStatus: null,
      owners: [],
    });
    const verdicts = runDiscriminators(BOSCH_ROW, unplaced);

    // The shape the rule turns on: nothing failed, and nothing placed it.
    expect(verdicts.some((v) => v.verdict === 'fail')).toBe(false);
    for (const name of ['country', 'locality', 'street', 'lei_witness']) {
      expect(verdictFor(verdicts, name).verdict, name).toBe('unavailable');
    }

    const outcome = evaluateAutoAccept([
      { candidate: candidate({}), verdicts: runDiscriminators(BOSCH_ROW, candidate({})) },
      { candidate: unplaced, verdicts },
    ]);
    expect(outcome.accepted).toBe(true);
  });

  it('does NOT count Sayari’s real ROBERT BOSCH record, once the street rung stops reading the name', () => {
    /**
     * **The record that cost row 1 its zero-token settlement, and the two
     * changes that stopped it.**
     *
     * `ROBERT BOSCH`, entity `45y20w00TGt2FpimbCEbdA`, is an Indonesian
     * trade-derived company with sixty-odd Jakarta addresses. Most carry
     * `country: IDN`, which fails against a DEU roster row, so
     * `compareAddresses` anchors on one of the addresses whose country is null
     * — and the one it picked has the line
     * `BUILDING TECHNOLOGIES, (BT-AI/SAL2) ROBERT BOSCH (SOUTH EAST ASIA) PTE`.
     *
     * The roster line is `Robert-Bosch-Platz 1 70839 Gerlingen`. Strip the
     * city, the postcode and the stopword `platz` and its "street-level"
     * tokens were `robert`, `bosch`, `1` — two thirds of them the company's own
     * name, because the street is named after the company. They matched the
     * company's name in the candidate's address line, `street` returned `pass`,
     * and a record that had produced no location evidence at all counted as a
     * rival placed at the roster address.
     *
     * The street rung now drops a token that is also in the roster name or the
     * Candidate's label, keeping numbers. `1` is all that survives, it is not on
     * this record's line, and the record fails street — so it is doubly not a
     * rival: nothing places it, and it has a `fail`.
     */
    const tradeRecord = candidate({
      entityId: 'bosch-idn',
      label: 'ROBERT BOSCH',
      country: null,
      addresses: [
        { city: null, postcode: null, country: 'IDN', line: 'JL.PASAR BARU NO.125 JAKARTA' },
        {
          city: null,
          postcode: null,
          country: null,
          line: 'BUILDING TECHNOLOGIES, (BT-AI/SAL2) ROBERT BOSCH (SOUTH EAST ASIA) PTE',
        },
      ],
      aliases: ['Bosch'],
      lei: null,
      gleif: undefined,
      latestStatus: null,
      owners: [],
    });
    const verdicts = runDiscriminators(BOSCH_ROW, tradeRecord);

    expect(verdictFor(verdicts, 'country').verdict).toBe('unavailable');
    expect(verdictFor(verdicts, 'locality').verdict).toBe('unavailable');
    expect(verdictFor(verdicts, 'street').verdict).toBe('fail');

    const outcome = evaluateAutoAccept([
      { candidate: candidate({}), verdicts: runDiscriminators(BOSCH_ROW, candidate({})) },
      { candidate: tradeRecord, verdicts },
    ]);
    expect(outcome.accepted).toBe(true);
  });

  it('still places the right company on the same roster row, by its house number', () => {
    // The other half of the same change: dropping the company's name from the
    // roster's street tokens must not cost the correct record its street
    // agreement. `1` survives the drop and is on ROBERT BOSCH GMBH's own line.
    const verdicts = runDiscriminators(BOSCH_ROW, candidate({}));
    expect(verdictFor(verdicts, 'street').verdict).toBe('pass');
    expect(verdictFor(verdicts, 'street').reasoning).toMatch(/"1"/);
  });

  it('still accepts when every rival carries a reason it is not the company', () => {
    const adsys = noida({ entityId: 'adsys', label: 'SAMVARDHANA MOTHERSON ADSYS TECH LIMITED' });
    const dissolved = noida({
      entityId: 'dissolved',
      label: 'SAMVARDHANA MOTHERSON SOMETHING LIMITED',
      latestStatus: 'dissolved',
    });
    const outcome = evaluateAutoAccept(
      [adsys, dissolved].map((c) => ({ candidate: c, verdicts: runDiscriminators(SM_ROW, c) })),
    );
    expect(outcome.accepted).toBe(true);
  });
});

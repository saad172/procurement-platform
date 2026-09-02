import { describe, expect, it } from 'vitest';
import {
  compareAddress,
  compareAddresses,
  containsWholeWord,
  isUnreadableScript,
  normaliseAddress,
  normaliseCityName,
  normaliseCountryToIso3,
  normalisePostcode,
  sameCountry,
} from '@/domain/match/address-ladder';

/**
 * SPEC §6.2 — the three-rung ladder, and why there is no address parser.
 */

describe('whole-word containment is what makes a parser unnecessary', () => {
  it('kills the town-level false positive a parser is bought for', () => {
    // `Stuttgarter Straße` contains `Stuttgart` as a SUBSTRING but not as a
    // TOKEN. This single case is the entire argument against a ~2 GB dependency.
    expect(containsWholeWord('Stuttgarter Straße 12, 70435', 'Stuttgart')).toBe(false);
    expect(containsWholeWord('Stuttgart, 70435', 'Stuttgart')).toBe(true);
  });

  it('requires a multi-word needle to appear contiguously', () => {
    expect(containsWholeWord('New Road, York', 'New York')).toBe(false);
    expect(containsWholeWord('1 Main St, New York', 'New York')).toBe(true);
  });

  it('folds diacritics and ß, which this roster needs', () => {
    // Real roster rows: Löwentaler Straße, Công ty TNHH BOSCH Việt Nam.
    expect(normaliseAddress('Löwentaler Straße')).toBe('lowentaler strasse');
    expect(
      containsWholeWord('Löwentaler Straße 20, 88046 Friedrichshafen', 'Friedrichshafen'),
    ).toBe(true);
    expect(containsWholeWord('Công ty TNHH BOSCH Việt Nam', 'Viet Nam')).toBe(true);
  });
});

describe('the three rungs', () => {
  const bosch = {
    rosterAddress: 'Robert-Bosch-Platz 1 70839 Gerlingen',
    rosterCountry: 'DEU',
  };

  it('passes all three where the candidate really is at the roster address', () => {
    const result = compareAddress({
      ...bosch,
      candidateCountry: 'DEU',
      candidateCity: 'Gerlingen',
      candidatePostcode: '70839',
      candidateLine: 'Robert-Bosch-Platz 1, 70839 Gerlingen, DE',
    });
    expect(result.country).toBe('pass');
    expect(result.locality).toBe('pass');
    expect(result.street).toBe('pass');
    // The street rung compares real tokens now: `platz` is a stopword,
    // `gerlingen` is the city and `70839` is the postcode, so what is left of
    // the roster line is the name and the house number.
    expect(result.evidence.streetTokensMatched).toEqual(['robert', 'bosch', '1']);
  });

  it('treats the postcode as a strong signal in its own right', () => {
    // Sayari's structured city can differ from the roster's while the postcode
    // still pins the same place.
    const result = compareAddress({
      ...bosch,
      candidateCountry: 'DEU',
      candidateCity: 'Stuttgart',
      candidatePostcode: '70839',
      candidateLine: 'Robert-Bosch-Platz 1, 70839, DE',
    });
    expect(result.locality).toBe('pass');
    expect(result.evidence.postcodeMatched).toBe(true);
  });

  it('fails locality when neither city nor postcode appears', () => {
    const result = compareAddress({
      ...bosch,
      candidateCountry: 'DEU',
      candidateCity: 'Waiblingen',
      candidatePostcode: '71332',
      candidateLine: 'Stuttgarter Strasse 130, 71332 Waiblingen, DE',
    });
    expect(result.locality).toBe('fail');
  });

  it('returns unavailable rather than fail when there is nothing to compare', () => {
    // An absent structured city is not evidence that the city is wrong, and an
    // address with no line at all is not an address on a different street.
    const result = compareAddress({
      ...bosch,
      candidateCountry: 'DEU',
      candidateCity: null,
      candidatePostcode: null,
      candidateLine: null,
    });
    expect(result.locality).toBe('unavailable');
    expect(result.street).toBe('unavailable');
  });
});

/**
 * **The street rung compares streets** (the same-address anchoring change).
 *
 * It used to mirror the locality verdict and report "street-level tokens
 * agree" — a sentence about a comparison that had never happened. It now
 * subtracts the anchored address's own city, postcode and generic street words
 * from both sides and compares what is left.
 */
describe('street compares real street tokens', () => {
  const mahle = {
    rosterAddress: 'Pragstraße 26-46 70376 Stuttgart',
    rosterCountry: 'DEU',
  };

  it('fails a different building in the agreeing town', () => {
    // MAHLE BEHR GMBH & CO. KG, measured: the right city, the wrong street.
    // Under the old rule street simply repeated locality and passed.
    const result = compareAddress({
      ...mahle,
      candidateCountry: 'DEU',
      candidateCity: 'Stuttgart',
      candidatePostcode: 'NA70469',
      candidateLine: 'MAUSERSTR. 3 STUTTGART 70469 DE',
    });
    expect(result.locality).toBe('pass');
    expect(result.street).toBe('fail');
  });

  it('passes the same building', () => {
    const result = compareAddress({
      ...mahle,
      candidateCountry: 'DEU',
      candidateCity: 'STUTTGART',
      candidatePostcode: '70376',
      candidateLine: 'Pragstrasse 26-46, Stuttgart D-70376, DE',
    });
    expect(result.street).toBe('pass');
    expect(result.evidence.streetTokensMatched).toContain('pragstrasse');
  });

  it('returns unavailable when the roster line is only a city', () => {
    // "Marunouchi, Chiyoda-ku, Tokyo" — a district, not a building.
    const result = compareAddress({
      rosterAddress: 'Tokyo',
      rosterCountry: 'JPN',
      candidateCountry: 'JPN',
      candidateCity: 'Tokyo',
      candidatePostcode: null,
      candidateLine: '1-1 Otemachi, Tokyo, JP',
    });
    expect(result.locality).toBe('pass');
    expect(result.street).toBe('unavailable');
  });
});

/**
 * **A street named after the company is not evidence about the company.**
 *
 * Roster row 1 is `Robert-Bosch-Platz 1 70839 Gerlingen`. Subtract the city,
 * the postcode and the stopword `platz` and the "street-level" tokens are
 * `robert`, `bosch`, `1` — two thirds of them the company's own name. Any
 * record whose address line mentions Bosch matched on the street rung, and one
 * did.
 *
 * `nameTokens` carries the roster name's and the Candidate label's own
 * significant tokens down from `runDiscriminators`, and the street rung drops
 * them before comparing — **keeping numbers**, because a house number is a real
 * street token whatever the company is called.
 */
describe("the street rung drops the company's own name", () => {
  const bosch = {
    rosterAddress: 'Robert-Bosch-Platz 1 70839 Gerlingen',
    rosterCountry: 'DEU',
    // What `name_cover` reads for roster "Bosch" against "ROBERT BOSCH GMBH".
    nameTokens: ['bosch', 'robert', 'bosch'],
  };

  it('keeps the house number, and passes the company that is really there', () => {
    const result = compareAddress({
      ...bosch,
      candidateCountry: 'DEU',
      candidateCity: 'Gerlingen',
      candidatePostcode: '70839',
      candidateLine: 'Robert-Bosch-Platz 1, 70839 Gerlingen, DE',
    });
    // `robert` and `bosch` are the company; `1` is the building.
    expect(result.evidence.rosterStreetTokens).toEqual(['robert', 'bosch', '1']);
    expect(result.evidence.distinctiveStreetTokens).toEqual(['1']);
    expect(result.street).toBe('pass');
    expect(result.evidence.streetTokensMatched).toEqual(['1']);
  });

  it('fails a trade record whose address line is just the company name', () => {
    /**
     * The measured rival: `ROBERT BOSCH`, entity `45y20w00TGt2FpimbCEbdA`, an
     * Indonesian trade-derived company. Its country-less address line names the
     * company and no building on Robert-Bosch-Platz. Under the old rung this
     * returned `pass`, and a record with no location evidence at all counted as
     * placed at the roster address.
     */
    const result = compareAddress({
      ...bosch,
      candidateCountry: null,
      candidateCity: null,
      candidatePostcode: null,
      candidateLine: 'BUILDING TECHNOLOGIES, (BT-AI/SAL2) ROBERT BOSCH (SOUTH EAST ASIA) PTE',
    });
    // This address carries no city or postcode of its own, so `70839` and
    // `gerlingen` are not subtracted either — but `robert` and `bosch` are, and
    // they were the only tokens the record could ever have matched.
    expect(result.evidence.distinctiveStreetTokens).toEqual(['1', '70839', 'gerlingen']);
    expect(result.evidence.streetTokensMatched).toEqual([]);
    expect(result.street).toBe('fail');
  });

  it('would have matched on the company name without the drop, which is the bug', () => {
    /**
     * The same comparison with and without `nameTokens`, on an address whose
     * locality *does* agree — so the locality ceiling below is not what is
     * being measured and the name drop is isolated.
     *
     * Without it, a line that names the company and describes no building
     * matches on `robert` and `bosch` and the rung reports street agreement.
     */
    const line = 'ROBERT BOSCH GMBH, Gerlingen';
    const at = { candidateCountry: 'DEU', candidateCity: 'Gerlingen', candidatePostcode: '70839' };

    const withoutDrop = compareAddress({
      rosterAddress: bosch.rosterAddress,
      rosterCountry: bosch.rosterCountry,
      ...at,
      candidateLine: line,
    });
    expect(withoutDrop.locality).toBe('pass');
    expect(withoutDrop.street).toBe('pass');
    expect(withoutDrop.evidence.streetTokensMatched).toEqual(['robert', 'bosch']);

    const withDrop = compareAddress({ ...bosch, ...at, candidateLine: line });
    expect(withDrop.locality).toBe('pass');
    expect(withDrop.evidence.distinctiveStreetTokens).toEqual(['1']);
    expect(withDrop.street).toBe('fail');
  });

  it('returns unavailable when the street is ONLY the company name', () => {
    // No house number to survive the drop: the roster line has not described a
    // building, so no address can agree or disagree with it.
    const result = compareAddress({
      rosterAddress: 'Robert-Bosch-Platz 70839 Gerlingen',
      rosterCountry: 'DEU',
      nameTokens: ['bosch', 'robert'],
      candidateCountry: 'DEU',
      candidateCity: 'Gerlingen',
      candidatePostcode: '70839',
      candidateLine: 'Robert-Bosch-Platz, 70839 Gerlingen, DE',
    });
    expect(result.evidence.distinctiveStreetTokens).toEqual([]);
    expect(result.street).toBe('unavailable');
  });

  it('keeps a number even when the company name contains one', () => {
    // `Gestamp 2020 SL` must not be able to spend the roster's house number.
    const result = compareAddress({
      rosterAddress: 'Calle 2020 16 28014 Madrid',
      rosterCountry: 'ESP',
      nameTokens: ['gestamp', '2020'],
      candidateCountry: 'ESP',
      candidateCity: 'Madrid',
      candidatePostcode: '28014',
      candidateLine: 'CALLE 2020 16, Madrid, 28014, ES',
    });
    expect(result.evidence.distinctiveStreetTokens).toEqual(['2020', '16']);
    expect(result.street).toBe('pass');
  });
});

/**
 * **Street may never accept alone**, which the reasoning line has always said
 * and the rung did not enforce.
 *
 * `pass` requires `locality` to be `pass` **on the same anchored address**. A
 * token match under a locality that could not be read is not a building in
 * common, it is a coincidence — and because the anchor is chosen over the whole
 * address set, it is a coincidence with as many chances to fire as the record
 * has addresses.
 */
describe('street may never accept alone', () => {
  const bosch = {
    rosterAddress: 'Robert-Bosch-Platz 1 70839 Gerlingen',
    rosterCountry: 'DEU',
    nameTokens: ['bosch', 'robert', 'bosch'],
  };

  it('suppresses a token match when the locality could not be read', () => {
    /**
     * **The measured coincidence, at address 42 of 63.** Once the company's own
     * name is dropped, `Robert-Bosch-Platz 1` has exactly one distinctive street
     * token left — the bare digit `1` — and the Indonesian trade record's
     * `BLOK.A/1` tokenises to include it. Locality is `unavailable` on that
     * address, so the match is a digit collision rather than a building.
     */
    const result = compareAddress({
      ...bosch,
      candidateCountry: null,
      candidateCity: null,
      candidatePostcode: null,
      candidateLine: 'JL. TMN. TEKNO V SEKTOR XI BLOK.A/1, SETU, KEL.,KEC., KOTA TANGERANG SAL',
    });
    expect(result.locality).toBe('unavailable');
    // The comparison still happened and is still reported, so a reader can see
    // that "1" matched and why it did not count.
    expect(result.evidence.streetTokensMatched).toEqual(['1']);
    expect(result.street).toBe('unavailable');
  });

  it('still passes the same house number where the locality agrees', () => {
    // The other half: the ceiling must not cost the right building its street.
    const result = compareAddress({
      ...bosch,
      candidateCountry: 'DEU',
      candidateCity: 'Gerlingen',
      candidatePostcode: '70839',
      candidateLine: 'Robert-Bosch-Platz 1, 70839 Gerlingen, DE',
    });
    expect(result.locality).toBe('pass');
    expect(result.street).toBe('pass');
    expect(result.evidence.streetTokensMatched).toEqual(['1']);
  });

  it('leaves a mismatch as fail, because that is a claim about the street', () => {
    // A ceiling on agreement, not on rejection: suppressing this would turn a
    // Candidate that had been rejected into one that had merely not been placed.
    const result = compareAddress({
      rosterAddress: 'Pragstraße 26-46 70376 Stuttgart',
      rosterCountry: 'DEU',
      candidateCountry: 'DEU',
      candidateCity: null,
      candidatePostcode: null,
      candidateLine: 'MAUSERSTR. 3 MUEHLACKER DE',
    });
    expect(result.locality).toBe('unavailable');
    expect(result.street).toBe('fail');
  });

  it('anchors away from a coincidence, over the whole address set', () => {
    // The record that made this necessary, in miniature: no address can be
    // placed at Gerlingen, so none of them may be placed by a digit either.
    const result = compareAddresses({
      rosterAddress: bosch.rosterAddress,
      rosterCountry: bosch.rosterCountry,
      nameTokens: bosch.nameTokens,
      addresses: [
        { city: null, postcode: null, country: 'IDN', line: 'JL.PASAR BARU NO.125 JAKARTA' },
        { city: null, postcode: null, country: null, line: 'BLOK.A/1, SETU, KOTA TANGERANG' },
      ],
    });
    expect(result.street).not.toBe('pass');
    expect(result.locality).not.toBe('pass');
  });
});

/**
 * **One address answers all three rungs** — the anchoring change.
 *
 * Scoring each rung independently over the whole set is what let a subsidiary
 * pass: it files its parent's headquarters alongside its own works, so one
 * address answered `country` and another answered `locality`, and nothing asked
 * whether they were the same building.
 */
describe('the verdict is anchored on ONE recorded address', () => {
  const detroit = {
    rosterAddress: 'One Dauch Drive Detroit MI 48211',
    rosterCountry: 'USA',
  };

  it('still finds the roster city among many addresses (finding 12 is untouched)', () => {
    const result = compareAddresses({
      ...detroit,
      addresses: [
        { city: 'Silao', postcode: '36100', country: 'MEX', line: 'PARQUE INDUSTRIAL FIPASI' },
        {
          city: 'Detroit',
          postcode: '48211',
          country: 'USA',
          line: 'ONE DAUCH DRIVE, DETROIT MI 48211-1198',
        },
      ],
    });
    expect(result.country).toBe('pass');
    expect(result.locality).toBe('pass');
    expect(result.street).toBe('pass');
    expect(result.evidence.matchedAddressIndex).toBe(1);
    expect(result.evidence.addressesConsidered).toBe(2);
  });

  it('never mixes one address’s country with another’s street', () => {
    // The shape that mattered: a Thai company filing its American parent's
    // plant is still a Thai company, and reading `country` off Rayong while
    // reading `street` off Detroit describes no building that exists.
    const result = compareAddresses({
      ...detroit,
      addresses: [
        { city: 'RAYONG', postcode: '21140', country: 'THA', line: '500/52 MU 3 TA SIT, TH' },
      ],
    });
    expect(result.country).toBe('fail');
    expect(result.evidence.matchedAddressIndex).toBe(0);
  });
});

/**
 * Normalisation, on both sides of the locality rung. Each case below was
 * measured on the roster's own rows, and each one rejected the right company.
 */
describe('normalisation', () => {
  it('strips a leading country prefix from a postcode', () => {
    // The real MAHLE GmbH records file `D-70376` where the roster reads `70376`.
    expect(normalisePostcode('D-70376')).toBe('70376');
    expect(normalisePostcode('PIN-110044')).toBe('110044');
    expect(normalisePostcode('D 7000')).toBe('7000');
  });

  it('leaves a postcode that merely starts with letters alone', () => {
    // UK and US-state forms carry no separator, and mangling them would invent
    // a mismatch where the register was simply being itself.
    expect(normalisePostcode('SW1A 1AA')).toBe('SW1A 1AA');
    expect(normalisePostcode('AL7 1TW')).toBe('AL7 1TW');
    expect(normalisePostcode('NA70469')).toBe('NA70469');
    expect(normalisePostcode('48211-1198')).toBe('48211-1198');
  });

  it('strips a trailing postal-district number from a city', () => {
    // The old German postal districts are still in the register data.
    expect(normaliseCityName('Stuttgart 50')).toBe('Stuttgart');
    expect(normaliseCityName('Stuttgart')).toBe('Stuttgart');
    expect(normaliseCityName('Ludwigshafen am Rhein')).toBe('Ludwigshafen am Rhein');
  });

  it('reads a normalised postcode and city against the roster line', () => {
    const result = compareAddress({
      rosterAddress: 'Pragstraße 26-46 70376 Stuttgart',
      rosterCountry: 'DEU',
      candidateCountry: 'DEU',
      candidateCity: 'Stuttgart 50',
      candidatePostcode: 'D-70376',
      candidateLine: 'Pragstrasse 26-46, Stuttgart 50, D-70376, DE',
    });
    expect(result.locality).toBe('pass');
    expect(result.evidence.postcodeMatched).toBe(true);
    expect(result.street).toBe('pass');
  });
});

/**
 * A script this build cannot read is **absent evidence, not contrary
 * evidence** — `normaliseAddress` deletes every character outside `[a-z0-9]`,
 * so CJK, Cyrillic, Arabic and Thai all reduce to nothing.
 */
describe('an unreadable script is unavailable, never fail', () => {
  it('recognises text that survives normalisation and text that does not', () => {
    expect(isUnreadableScript('東京都 千代田区')).toBe(true);
    expect(isUnreadableScript('Рособоронэкспорт')).toBe(true);
    expect(isUnreadableScript('Stuttgart')).toBe(false);
    expect(isUnreadableScript('')).toBe(false);
    expect(isUnreadableScript(null)).toBe(false);
  });

  it('returns unavailable for a locality written in a script it cannot read', () => {
    const result = compareAddress({
      rosterAddress: '5-33 Kitahama 4-chome Chuo-ku Osaka 541-0041',
      rosterCountry: 'JPN',
      candidateCountry: 'JPN',
      candidateCity: '大阪府 大阪市中央区',
      candidatePostcode: null,
      candidateLine: '大阪府 大阪市中央区',
    });
    expect(result.country).toBe('pass');
    expect(result.locality).toBe('unavailable');
    expect(result.street).toBe('unavailable');
  });
});

describe('country comparison', () => {
  it('accepts ISO3 on both sides', () => {
    expect(sameCountry('DEU', 'DEU')).toBe(true);
    expect(sameCountry('DEU', 'JPN')).toBe(false);
  });

  it('accepts a country name where one side gives prose', () => {
    expect(sameCountry('DEU', 'Germany')).toBe(true);
    expect(sameCountry('USA', 'United States')).toBe(true);
    expect(sameCountry('KOR', 'Republic of Korea')).toBe(true);
  });
});

/**
 * `normaliseCountryToIso3` — the single normaliser `sameCountry()` above, the
 * settled-country derivation (`settle-match.ts`) and the LEI witness all reuse.
 * It reads the complete ISO 3166-1 table (`src/domain/iso3166.ts`) rather than
 * the seventeen-entry alias map it used to carry.
 */
describe('normaliseCountryToIso3', () => {
  it('returns an already-ISO3 value uppercased', () => {
    expect(normaliseCountryToIso3('DEU')).toBe('DEU');
    expect(normaliseCountryToIso3('jpn')).toBe('JPN');
  });

  it('resolves a country name to ISO3', () => {
    expect(normaliseCountryToIso3('Germany')).toBe('DEU');
    expect(normaliseCountryToIso3('Japan')).toBe('JPN');
    expect(normaliseCountryToIso3('South Korea')).toBe('KOR');
    // Sweden used to return null, because the old alias map held only the
    // roster's own origins — and Sweden is exactly the country finding 107
    // measured on a Japanese Supplier.
    expect(normaliseCountryToIso3('Sweden')).toBe('SWE');
  });

  it('returns null for a spelling it cannot place, rather than guessing', () => {
    expect(normaliseCountryToIso3('Ruritania')).toBeNull();
    expect(normaliseCountryToIso3('')).toBeNull();
  });
});

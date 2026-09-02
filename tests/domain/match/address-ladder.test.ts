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

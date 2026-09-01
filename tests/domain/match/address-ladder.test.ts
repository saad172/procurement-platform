import { describe, expect, it } from 'vitest';
import {
  compareAddress,
  containsWholeWord,
  normaliseAddress,
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
    });
    expect(result.country).toBe('pass');
    expect(result.locality).toBe('pass');
    expect(result.street).toBe('pass');
  });

  it('treats the postcode as a strong signal in its own right', () => {
    // Sayari's structured city can differ from the roster's while the postcode
    // still pins the same place.
    const result = compareAddress({
      ...bosch,
      candidateCountry: 'DEU',
      candidateCity: 'Stuttgart',
      candidatePostcode: '70839',
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
    });
    expect(result.locality).toBe('fail');
  });

  it('returns unavailable rather than fail when there is nothing to compare', () => {
    // An absent structured city is not evidence that the city is wrong.
    const result = compareAddress({
      ...bosch,
      candidateCountry: 'DEU',
      candidateCity: null,
      candidatePostcode: null,
    });
    expect(result.locality).toBe('unavailable');
    expect(result.street).toBe('unavailable');
  });

  it('cannot claim street agreement when the locality disagrees', () => {
    const result = compareAddress({
      ...bosch,
      candidateCountry: 'DEU',
      candidateCity: 'Munich',
      candidatePostcode: '80331',
    });
    expect(result.street).toBe('fail');
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

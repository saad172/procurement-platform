import { describe, expect, it } from 'vitest';
import {
  DEMONYMS,
  ISO_3166_COUNTRIES,
  alpha2ToAlpha3,
  alpha3ToAlpha2,
  countryName,
  isCountryWord,
  jurisdictionToAlpha3,
  toAlpha3,
} from '@/domain/iso3166';
import { iso3ToIso2 } from '@/upstream/endpoints';

/**
 * The complete ISO 3166-1 table (`src/domain/iso3166.ts`).
 *
 * It replaced an eleven-entry map because two identity checks needed the
 * mapping and could not get it: the LEI witness reads GLEIF's `jurisdiction`,
 * and `name_cover` has to recognise a country word standing in a Candidate's
 * surplus name tokens (SPEC §6.2).
 */

describe('the table itself', () => {
  it('carries every current ISO 3166-1 country, with unique codes', () => {
    expect(ISO_3166_COUNTRIES).toHaveLength(249);
    expect(new Set(ISO_3166_COUNTRIES.map((c) => c.alpha2)).size).toBe(249);
    expect(new Set(ISO_3166_COUNTRIES.map((c) => c.alpha3)).size).toBe(249);
  });

  it('uses well-formed codes throughout', () => {
    for (const country of ISO_3166_COUNTRIES) {
      expect(country.alpha2).toMatch(/^[A-Z]{2}$/);
      expect(country.alpha3).toMatch(/^[A-Z]{3}$/);
      expect(country.name.length).toBeGreaterThan(2);
    }
  });

  it("maps both ways for the roster's own eleven origins", () => {
    for (const [iso3, iso2] of [
      ['USA', 'US'],
      ['DEU', 'DE'],
      ['JPN', 'JP'],
      ['KOR', 'KR'],
      ['FRA', 'FR'],
      ['ESP', 'ES'],
      ['CAN', 'CA'],
      ['CHN', 'CN'],
      ['MEX', 'MX'],
      ['IND', 'IN'],
      ['GBR', 'GB'],
    ] as const) {
      expect(alpha3ToAlpha2(iso3)).toBe(iso2);
      expect(alpha2ToAlpha3(iso2)).toBe(iso3);
    }
  });

  it('returns undefined for a code that is not current, rather than echoing it', () => {
    // A caller comparing two countries has to be able to tell "these disagree"
    // from "this is not a country I can read".
    expect(alpha3ToAlpha2('SUN')).toBeUndefined();
    expect(alpha2ToAlpha3('ZZ')).toBeUndefined();
    expect(toAlpha3('Ruritania')).toBeUndefined();
    expect(toAlpha3('')).toBeUndefined();
    expect(toAlpha3(null)).toBeUndefined();
  });
});

describe('toAlpha3 reads whatever a source gives it', () => {
  it('takes alpha-3, alpha-2 and the ISO name', () => {
    expect(toAlpha3('DEU')).toBe('DEU');
    expect(toAlpha3('de')).toBe('DEU');
    expect(toAlpha3('Germany')).toBe('DEU');
    expect(toAlpha3('Korea, Republic of')).toBe('KOR');
  });

  it('takes the alias spellings GLEIF, Sayari and the roster actually use', () => {
    expect(toAlpha3('United States of America')).toBe('USA');
    expect(toAlpha3('USA')).toBe('USA');
    expect(toAlpha3('South Korea')).toBe('KOR');
    expect(toAlpha3('Czech Republic')).toBe('CZE');
    expect(toAlpha3('Türkiye')).toBe('TUR');
    expect(toAlpha3('Turkey')).toBe('TUR');
    expect(toAlpha3('Vietnam')).toBe('VNM');
    expect(toAlpha3("Côte d'Ivoire")).toBe('CIV');
  });
});

/**
 * GLEIF's `jurisdiction` is ISO 3166-**2** as often as 3166-1, and reading it
 * is the whole reason the LEI witness can tell a Thai subsidiary from its
 * American parent when both file the same headquarters city (finding 12's
 * successor: a company has many addresses, and so does its subsidiary).
 */
describe('jurisdictionToAlpha3', () => {
  it('reads a subdivision code as its country — US-DE is the United States', () => {
    expect(jurisdictionToAlpha3('US-DE')).toBe('USA');
    expect(jurisdictionToAlpha3('US-MI')).toBe('USA');
    expect(jurisdictionToAlpha3('CA-ON')).toBe('CAN');
  });

  it('reads a bare country code', () => {
    // The four measured on the roster's own rows.
    expect(jurisdictionToAlpha3('TH')).toBe('THA');
    expect(jurisdictionToAlpha3('DE')).toBe('DEU');
    expect(jurisdictionToAlpha3('IN')).toBe('IND');
    expect(jurisdictionToAlpha3('JP')).toBe('JPN');
    expect(jurisdictionToAlpha3('ES')).toBe('ESP');
  });

  it('returns undefined when there is nothing to read', () => {
    expect(jurisdictionToAlpha3(null)).toBeUndefined();
    expect(jurisdictionToAlpha3('')).toBeUndefined();
    expect(jurisdictionToAlpha3('XX-99')).toBeUndefined();
  });
});

describe('countryName', () => {
  it('names an alpha-3 so a reasoning line can quote it', () => {
    expect(countryName('THA')).toBe('Thailand');
    expect(countryName('USA')).toBe('United States');
    expect(countryName('ZZZ')).toBeUndefined();
  });
});

/**
 * `isCountryWord` is what makes `(Thailand)` and `de Mexico` visible to
 * `name_cover`. Its failure direction is deliberate: a false positive costs one
 * `unavailable` verdict — a reason to look — while a false negative is how a
 * subsidiary gets accepted as its parent.
 */
describe('isCountryWord', () => {
  it('recognises the country words the roster actually produced', () => {
    expect(isCountryWord('thailand')).toBe(true);
    expect(isCountryWord('mexico')).toBe(true);
    expect(isCountryWord('germany')).toBe(true);
    expect(isCountryWord('india')).toBe(true);
    expect(isCountryWord('korea')).toBe(true);
    expect(isCountryWord('china')).toBe(true);
    expect(isCountryWord('brazil')).toBe(true);
  });

  it('recognises a nationality and a region', () => {
    expect(isCountryWord('german')).toBe(true);
    expect(isCountryWord('japanese')).toBe(true);
    expect(isCountryWord('europe')).toBe(true);
    expect(isCountryWord('emea')).toBe(true);
  });

  it('does NOT fire on the generic words ISO country names are full of', () => {
    // Without this exclusion "United Technologies" would read as carrying a
    // country word, and every such name would lose its verdict for nothing.
    for (const word of ['united', 'states', 'republic', 'islands', 'new', 'north', 'saint']) {
      expect(isCountryWord(word), word).toBe(false);
    }
  });

  it("does NOT fire on the surplus words the roster's own right answers carry", () => {
    // Measured: these are the surplus tokens of Candidates that must still pass
    // `name_cover` — Robert Bosch GmbH, Compagnie Plastic Omnium, Grupo Antolin
    // Irausa SA, Sumitomo Electric Industries, Toyoda Gosei Company Limited.
    for (const word of [
      'robert',
      'compagnie',
      'irausa',
      'industries',
      'company',
      'behr',
      'adsys',
    ]) {
      expect(isCountryWord(word), word).toBe(false);
    }
  });

  it('lists every demonym exactly once, lower-cased', () => {
    expect(new Set(DEMONYMS).size).toBe(DEMONYMS.length);
    for (const demonym of DEMONYMS) expect(demonym).toBe(demonym.toLowerCase());
  });
});

/**
 * `iso3ToIso2` in `endpoints.ts` now reads this table rather than its own
 * eleven-entry copy. Its contract is unchanged where it mattered: an
 * unreadable value returns `undefined`, which **drops** the GLEIF country
 * filter rather than sending a code that silently matches nothing.
 */
describe('the GLEIF endpoint reads the same table', () => {
  it('maps the eleven it always mapped', () => {
    expect(iso3ToIso2('DEU')).toBe('DE');
    expect(iso3ToIso2('JPN')).toBe('JP');
  });

  it('now maps the rest of the world too', () => {
    expect(iso3ToIso2('THA')).toBe('TH');
    expect(iso3ToIso2('SWE')).toBe('SE');
    expect(iso3ToIso2('BRA')).toBe('BR');
  });

  it('passes an alpha-2 through and drops what it cannot read', () => {
    expect(iso3ToIso2('de')).toBe('DE');
    expect(iso3ToIso2(undefined)).toBeUndefined();
    expect(iso3ToIso2('ZZZ')).toBeUndefined();
  });
});

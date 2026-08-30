import { describe, expect, it } from 'vitest';
import { normaliseRowIds, rawBodyHash, wireHash } from '@/model/wire';

const A = 'a4ea162a-1cbb-54e3-a646-36e332386843';
const B = '718d64ae-10d8-4372-8d5a-d6872d8cf3e2';

/**
 * A prompt contains database row ids because a Citation points at a row, and
 * row instants because a Match records when it was settled. Neither can be
 * reproduced by a replay — the ids differ per database and a replay is
 * time-shifted by construction — so the hash is taken over a projection with
 * both collapsed.
 *
 * These tests pin **what the projection still notices**, because a hash that
 * had quietly become insensitive to real change would be worse than no hash: it
 * would look like a guarantee.
 */
describe('normaliseRowIds', () => {
  it('collapses every uuid to one placeholder', () => {
    expect(normaliseRowIds(`${A} then ${B} then ${A}`)).toBe('«id» then «id» then «id»');
  });

  it('collapses every instant to one placeholder', () => {
    expect(normaliseRowIds('at 2026-08-30T20:28:45.709Z and 2026-08-31T09:44:02.007Z')).toBe(
      'at «ts» and «ts»',
    );
  });

  it('makes two databases agree on the same request', () => {
    // The same prompt, with rows minted twice. This is the whole point.
    expect(wireHash(`{"cite":"${A}","match":"${B}"}`)).toBe(wireHash(`{"cite":"${B}","match":"${A}"}`));
  });

  it('does not care whether two instants coincide', () => {
    // A recorded run wrote a row and fetched it a second apart; a replay's
    // pipeline may do both inside one millisecond.
    expect(wireHash('{"fetchedAt":"2026-08-30T20:28:45.709Z","firstSeenAt":"2026-08-30T20:28:46.001Z"}')).toBe(
      wireHash('{"fetchedAt":"2026-08-30T20:49:40.840Z","firstSeenAt":"2026-08-30T20:49:40.840Z"}'),
    );
  });
});

/**
 * The other half: everything that is not a database-minted value is still
 * hashed as it stands. These are the changes a replay exists to catch.
 */
describe('what the projection still catches', () => {
  it('a Sayari entity id, because it names a different company', () => {
    const text = 'entity CX3012yTGIhgMxcZG6hgnA';
    expect(normaliseRowIds(text)).toBe(text);
    expect(wireHash('{"e":"CX3012yTGIhgMxcZG6hgnA"}')).not.toBe(wireHash('{"e":"LAtrDml3ulKGjNIIFGSNAg"}'));
  });

  it('a plain date, because a date is content here', () => {
    // A registration date, a latest shipment, a WGI vintage.
    const text = 'registered 1886-11-15, last shipped 2026-06-16';
    expect(normaliseRowIds(text)).toBe(text);
    expect(wireHash('{"registrationDate":"1886-11-15"}')).not.toBe(
      wireHash('{"registrationDate":"1886-11-16"}'),
    );
  });

  it('an LEI, an HS code and a number', () => {
    const text = 'LEI 35380087YNQB9R822X46 rate 5 hs 8544.30';
    expect(normaliseRowIds(text)).toBe(text);
    expect(wireHash('{"rate":5}')).not.toBe(wireHash('{"rate":6}'));
  });

  it('a changed prompt', () => {
    expect(wireHash('{"system":"Answer briefly."}')).not.toBe(
      wireHash('{"system":"Answer briefly. In French."}'),
    );
  });
});

/**
 * `rawBodyHash` makes no judgement at all, which is exactly why
 * `fixtures:rehash` keys on it: the wire hash is *designed* to change as the
 * notion of "the same request" is refined, and a recovery mechanism keyed on
 * the thing it recovers from breaks on its second use.
 */
describe('rawBodyHash', () => {
  it('distinguishes bodies the wire hash deliberately equates', () => {
    const one = `{"id":"${A}"}`;
    const two = `{"id":"${B}"}`;
    expect(wireHash(one)).toBe(wireHash(two));
    expect(rawBodyHash(one)).not.toBe(rawBodyHash(two));
  });

  it('is stable for identical bytes', () => {
    expect(rawBodyHash('{"a":1}')).toBe(rawBodyHash('{"a":1}'));
  });
});

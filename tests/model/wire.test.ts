import { describe, expect, it } from 'vitest';
import { normaliseRowIds, wireHash } from '@/model/wire';

const A = 'a4ea162a-1cbb-54e3-a646-36e332386843';
const B = '718d64ae-10d8-4372-8d5a-d6872d8cf3e2';
const C = '00bec201-a07d-4b11-9d34-8d1c7c9c4d21';

/**
 * A prompt contains database row ids because a Citation points at a row. Those
 * ids differ in every database, so the hash is taken over a projection with
 * them numbered by first appearance.
 *
 * These tests pin **what that projection still notices**, because a hash that
 * had quietly become insensitive to real change would be worse than no hash: it
 * would look like a guarantee.
 */
describe('normaliseRowIds', () => {
  it('numbers ids by first appearance', () => {
    expect(normaliseRowIds(`${A} then ${B} then ${A}`)).toBe('«id:0» then «id:1» then «id:0»');
  });

  it('makes two databases agree on the same request', () => {
    // The same prompt, with rows minted twice. This is the whole point.
    expect(wireHash(`{"cite":"${A}","match":"${B}"}`)).toBe(
      wireHash(`{"cite":"${C}","match":"${A}"}`),
    );
  });

  it('still notices a different NUMBER of rows', () => {
    expect(wireHash(`{"cite":["${A}"]}`)).not.toBe(wireHash(`{"cite":["${A}","${B}"]}`));
  });

  it('still notices a changed pattern of repetition', () => {
    // Citing one row twice is a different claim from citing two rows once each,
    // and the projection has to keep that difference.
    expect(wireHash(`{"a":"${A}","b":"${A}"}`)).not.toBe(wireHash(`{"a":"${A}","b":"${B}"}`));
  });

  it('leaves a Sayari entity id alone, because it is content', () => {
    // 22-char base64url, not a uuid. A changed entity id means the model was
    // shown a different company — exactly the drift a replay must catch.
    const text = 'entity CX3012yTGIhgMxcZG6hgnA';
    expect(normaliseRowIds(text)).toBe(text);
    expect(wireHash('{"e":"CX3012yTGIhgMxcZG6hgnA"}')).not.toBe(
      wireHash('{"e":"LAtrDml3ulKGjNIIFGSNAg"}'),
    );
  });

  it('leaves an LEI and a number alone', () => {
    const text = 'LEI 35380087YNQB9R822X46 rate 5 hs 8544.30';
    expect(normaliseRowIds(text)).toBe(text);
  });

  it('is case-insensitive about the same id', () => {
    expect(normaliseRowIds(`${A} ${A.toUpperCase()}`)).toBe('«id:0» «id:0»');
  });
});

describe('normaliseRowIds — instants', () => {
  it('normalises a row instant, which a replay can never reproduce', () => {
    expect(wireHash('{"settledAt":"2026-08-30T14:02:11.481Z"}')).toBe(
      wireHash('{"settledAt":"2026-08-31T09:44:02.007Z"}'),
    );
  });

  it('leaves a plain date alone, because a date is content here', () => {
    // A registration date, a latest shipment, a WGI vintage — a change in one
    // is exactly the drift a replay must catch.
    const text = 'registered 1886-11-15, last shipped 2026-06-16';
    expect(normaliseRowIds(text)).toBe(text);
    expect(wireHash('{"registrationDate":"1886-11-15"}')).not.toBe(
      wireHash('{"registrationDate":"1886-11-16"}'),
    );
  });

  it('keeps ids and instants in separate numbering', () => {
    const out = normaliseRowIds(`${A} at 2026-08-30T14:02:11.481Z`);
    expect(out).toContain('«id:');
    expect(out).toContain('«ts:');
  });
});

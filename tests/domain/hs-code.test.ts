import { describe, expect, it } from 'vitest';
import { chooseHtsLine, hsDigits, hsHeading } from '@/domain/hs-code';
import { CATEGORIES } from '@/db/seed-data/program';

/**
 * The two HS widths, tested on the codes the seed actually carries (SPEC
 * §7.1, §11).
 *
 * Both of these were inline expressions with no name and no test: a
 * `slice(0, 6)` in the middle of Discover's query builder and a `startsWith`
 * inside the tariff Enrichment. They are halves of one idea — *this line, or
 * the heading it sits under* — and the seed is full of cases where the
 * difference decides the number: `8419.50.10.00` is 4.2% while everything else
 * under `8419.50` is Free, and `8708.99`'s lines run Free to 2.5%.
 */

const SEED_LINES = CATEGORIES.flatMap((category) =>
  category.hsLines.map((line) => ({ code: category.code, hsCode: line.hsCode })),
);

describe('hsHeading', () => {
  it('widens each of the seed’s lines to six digits', () => {
    expect(Object.fromEntries(SEED_LINES.map((l) => [l.hsCode, hsHeading(l.hsCode)]))).toEqual({
      '8507.60.00.10': '850760',
      '7616.99.51.60': '761699',
      '7326.90.86.88': '732690',
      '8708.99.81': '870899',
      '8544.30': '854430',
      '8504.40': '850440',
      '8419.50.10.00': '841950',
      '8708.91': '870891',
      '8415.20': '841520',
      '9401.20': '940120',
      '8708.30': '870830',
      '8708.94': '870894',
      '8512.20': '851220',
      '8512.20.40': '851220',
    });
  });

  it('is idempotent — a heading widened again is the same heading', () => {
    for (const line of SEED_LINES) {
      expect(hsHeading(hsHeading(line.hsCode))).toBe(hsHeading(line.hsCode));
    }
  });

  it('collapses the two LGT lines onto one heading, which is why Discover dedupes', () => {
    // `8512.20` and `8512.20.40` are two different general rates — 0% and 2.5%
    // — under one heading. Trade data cannot tell them apart, and the tariff
    // Criterion must.
    expect(hsHeading('8512.20')).toBe(hsHeading('8512.20.40'));
    expect(hsDigits('8512.20.40')).not.toBe(hsDigits('8512.20'));
  });

  it('returns a short code whole rather than padding it into a heading', () => {
    expect(hsHeading('8544')).toBe('8544');
  });
});

describe('chooseHtsLine', () => {
  it('prefers the line that carries the queried code exactly', () => {
    const lines = [
      { htsno: '8512.20.20.00', general: 'Free' },
      { htsno: '8512.20.40', general: '2.5%' },
      { htsno: '8512.20.40.00', general: '2.5%' },
    ];
    const chosen = chooseHtsLine(lines, '8512.20.40');
    expect(chosen.matchedBy).toBe('exact');
    expect(chosen.line?.htsno).toBe('8512.20.40');
  });

  it('falls back to the most general line beneath the code, and says so', () => {
    // The recorded USITC body for the HAR category is exactly this shape: the
    // Category asks for the six-digit `8544.30` and the source answers with
    // the ten-digit line that carries the rate.
    const chosen = chooseHtsLine([{ htsno: '8544.30.00.00', general: '5%' }], '8544.30');
    expect(chosen.matchedBy).toBe('sub_line');
    expect(chosen.line?.htsno).toBe('8544.30.00.00');
  });

  it('orders the fallback rather than taking whichever line came first', () => {
    // The bug this replaces: `rows.find(startsWith)` took the API's first hit,
    // so the rate depended on the order a source chose to list its lines in.
    const lines = [
      { htsno: '8708.99.81.80', general: '2.5%' },
      { htsno: '8708.99.81', general: 'Free' },
      { htsno: '8708.99.81.15', general: '2.5%' },
    ];
    const forward = chooseHtsLine(lines, '8708.99');
    const reversed = chooseHtsLine([...lines].reverse(), '8708.99');
    expect(forward.line?.htsno).toBe('8708.99.81');
    expect(reversed.line?.htsno).toBe(forward.line?.htsno);
  });

  it('matches on digits, so the source’s dotting cannot decide the rate', () => {
    expect(chooseHtsLine([{ htsno: '85443000 00' }], '8544.30.00.00').matchedBy).toBe('exact');
  });

  it('reports `none` rather than reaching sideways for a sibling’s rate', () => {
    // A line under a DIFFERENT code of the same heading is another product's
    // rate. `8419.50.10.00` is 4.2% while the rest of `8419.50` is Free, so
    // widening past the code asked for would write a fabricated figure into a
    // Score — the one failure SPEC §9.1 names as the worst.
    const chosen = chooseHtsLine([{ htsno: '8419.50.50.00', general: 'Free' }], '8419.50.10.00');
    expect(chosen.matchedBy).toBe('none');
    expect(chosen.line).toBeUndefined();
  });

  it('reports `none` on an empty result set', () => {
    expect(chooseHtsLine([], '8544.30')).toEqual({ line: undefined, matchedBy: 'none' });
  });
});

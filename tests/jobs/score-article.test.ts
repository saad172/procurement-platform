import { describe, expect, it } from 'vitest';
import { scoreArticle } from '@/jobs/enrich-supplier';

/**
 * `scoreArticle` handles record-shaped `risk_flags` (SPEC §9.2, ticket 01
 * item E).
 *
 * `risk_flags` arrives as an array on every recorded body this suite has, and
 * the projection at `src/upstream/projections/sayari.ts:310` admits a record
 * too (`z.union([z.array(z.string()), z.record(z.string(), z.unknown())])`).
 * No recorded fixture holds a record-shaped example, so this is hand-built
 * from the schema's own admitted shape and the flag-name vocabulary the
 * negative-news schema comment names ("Human Rights", "Labor Dispute", "Law
 * Enforcement or Regulatory Action") — no live call is needed to prove the
 * counting logic treats a record's keys the way it already treats an array's
 * entries.
 */
describe('scoreArticle: array and record risk_flags count the same way', () => {
  it('counts an array of flags as before — the untouched case', () => {
    expect(scoreArticle(['Sanctions List', 'Labor Dispute'])).toEqual({
      seriousFlags: 1,
      moderateFlags: 1,
    });
  });

  it('counts a record’s KEYS the same way it counts an array’s entries', () => {
    const asArray = scoreArticle(['Sanctions List', 'Labor Dispute', 'Human Rights']);
    const asRecord = scoreArticle({
      'Sanctions List': true,
      'Labor Dispute': { detail: 'strike' },
      'Human Rights': {},
    });
    expect(asRecord).toEqual(asArray);
  });

  it('weighs a serious flag among a record’s keys, not only an array’s entries', () => {
    expect(scoreArticle({ Sanctioned: true, Fraudulent: true, Corruption: true })).toEqual({
      seriousFlags: 3,
      moderateFlags: 0,
    });
  });

  it('is empty for null, undefined, and an empty record', () => {
    expect(scoreArticle(null)).toEqual({ seriousFlags: 0, moderateFlags: 0 });
    expect(scoreArticle(undefined)).toEqual({ seriousFlags: 0, moderateFlags: 0 });
    expect(scoreArticle({})).toEqual({ seriousFlags: 0, moderateFlags: 0 });
  });

  it('does not read a record shaped like risk_flags as an array of its values', () => {
    // A record with numeric-looking values must not be coerced through
    // Object.values and read as an array of flag names.
    const result = scoreArticle({ Fraud: 1, Corruption: 2 });
    expect(result.seriousFlags).toBe(2);
  });
});

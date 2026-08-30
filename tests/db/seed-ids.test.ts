import { describe, expect, it } from 'vitest';
import { seedId } from '@/db/seed-data/ids';

/**
 * The property the seed relies on: same key, same id, on every machine.
 *
 * These are not snapshot tests of the hash — they pin the *shape* and the
 * *determinism*, which is what a fixture recorded on one database and replayed
 * on another actually depends on.
 */
describe('seedId', () => {
  it('is stable for the same kind and key', () => {
    expect(seedId('category', 'BAT')).toBe(seedId('category', 'BAT'));
  });

  it('separates kinds, so a Category and a Plant sharing a code do not collide', () => {
    expect(seedId('category', 'P1')).not.toBe(seedId('plant', 'P1'));
  });

  it('separates keys', () => {
    expect(seedId('category', 'BAT')).not.toBe(seedId('category', 'HAR'));
  });

  it('produces a well-formed v5 UUID', () => {
    // Version 5 and the RFC 4122 variant, so anything that parses a UUID — and
    // Postgres does — accepts it.
    expect(seedId('program', 'MY2029')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

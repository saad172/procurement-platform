import { describe, expect, it } from 'vitest';
import { seedFor, shuffleCandidates } from '@/domain/match/shuffle';

/**
 * SPEC §19.1, determinism fix 1.
 *
 * The shuffle exists to remove positional bias from the blind evaluator. It
 * does **not** exist to be unpredictable — and seeding it is what carries the
 * replay: unseeded, the evaluator's *prompt* would differ between recording and
 * replay, so the stored response would be answering a different question.
 */

const CANDIDATES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

/** The seed's three components: the Supplier, the attempt, the Round. */
const SUPPLIER = 'supplier-1';

describe('shuffleCandidates', () => {
  it('is deterministic for one seed', () => {
    const seed = seedFor(SUPPLIER, 1, 1);
    expect(shuffleCandidates(CANDIDATES, seed)).toEqual(shuffleCandidates(CANDIDATES, seed));
  });

  it('differs between Rounds of the same attempt', () => {
    // Each Round is a fresh look, so the ordering should not carry over.
    const round1 = shuffleCandidates(CANDIDATES, seedFor(SUPPLIER, 1, 1));
    const round2 = shuffleCandidates(CANDIDATES, seedFor(SUPPLIER, 1, 2));
    expect(round1).not.toEqual(round2);
  });

  it('differs between attempts at the same Round, so a re-run is a second look', () => {
    // The seed used to be built from the SUPPLIER id and the Round while this
    // module's comment said it was built from the attempt — so a re-run showed
    // the blind evaluator the identical prompt it had already answered.
    const a = shuffleCandidates(CANDIDATES, seedFor(SUPPLIER, 1, 1));
    const b = shuffleCandidates(CANDIDATES, seedFor(SUPPLIER, 2, 1));
    expect(a).not.toEqual(b);
  });

  it('differs between Suppliers at the same attempt and Round', () => {
    const a = shuffleCandidates(CANDIDATES, seedFor('supplier-1', 1, 1));
    const b = shuffleCandidates(CANDIDATES, seedFor('supplier-2', 1, 1));
    expect(a).not.toEqual(b);
  });

  it('actually shuffles — it is not an expensive identity function', () => {
    const shuffled = shuffleCandidates(CANDIDATES, seedFor(SUPPLIER, 1, 1));
    expect(shuffled).not.toEqual(CANDIDATES);
  });

  it('keeps every candidate exactly once', () => {
    const shuffled = shuffleCandidates(CANDIDATES, seedFor(SUPPLIER, 9, 3));
    expect([...shuffled].sort()).toEqual([...CANDIDATES].sort());
  });

  it('does not mutate its input, so a retry starts from the same list', () => {
    const input = [...CANDIDATES];
    shuffleCandidates(input, seedFor(SUPPLIER, 1, 1));
    expect(input).toEqual(CANDIDATES);
  });

  it('handles the degenerate sizes without special-casing them', () => {
    expect(shuffleCandidates([], 1)).toEqual([]);
    expect(shuffleCandidates(['only'], 1)).toEqual(['only']);
  });

  it('derives the seed rather than storing it', () => {
    // Nothing has to remember the seed: it is a function of the Supplier id,
    // the attempt number and the Round number, all three of which are rows.
    expect(seedFor(SUPPLIER, 1, 1)).toBe(seedFor(SUPPLIER, 1, 1));
    expect(seedFor(SUPPLIER, 1, 1)).not.toBe(seedFor(SUPPLIER, 1, 2));
    expect(seedFor(SUPPLIER, 1, 1)).not.toBe(seedFor(SUPPLIER, 2, 1));
  });
});

import { createHash } from 'node:crypto';

/**
 * The Candidate shuffle, **seeded** (SPEC §19.1).
 *
 * The shuffle exists to remove positional bias from the blind evaluator — it
 * must not be able to prefer whatever happens to be first. It does **not**
 * exist to be unpredictable.
 *
 * Seeding it is what carries the replay. Unseeded, the evaluator's *prompt*
 * would differ between recording and replay, so the stored response would be
 * answering a different question — and a fixture that answers a different
 * question is not a fixture.
 *
 * The seed is `hash(supplier_id, attempt_n, round_n)`: stable for one Round of
 * one attempt, different across Rounds, different across attempts, and derived
 * rather than stored.
 *
 * **The attempt number is not decoration.** This module's own comment said the
 * seed was the attempt and the Round while the caller passed the *Supplier* id
 * and the Round — so every re-run of a Supplier shuffled its Candidates into
 * exactly the same order, and a second attempt showed the blind evaluator the
 * identical prompt it had already answered. A re-run that cannot vary the one
 * thing the shuffle exists to vary is not a second opinion.
 *
 * A replay stays deterministic because all three components are: the attempt
 * number is `max(attempt_n) + 1` over rows the replay recreates in the same
 * order.
 */

export function seedFor(supplierId: string, attemptN: number, roundN: number): number {
  const digest = createHash('sha256').update(`${supplierId}:${attemptN}:${roundN}`).digest();
  return digest.readUInt32BE(0);
}

/** A small deterministic PRNG. Nothing here needs cryptographic randomness. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates, driven by the seeded PRNG. Does not mutate its input. */
export function shuffleCandidates<T>(candidates: readonly T[], seed: number): T[] {
  const out = [...candidates];
  const random = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

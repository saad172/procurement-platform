import { seedId } from './ids';

/**
 * A **test-only Sourcing Programme** (SPEC §19.3).
 *
 * ## Why a second Programme rather than two more roster rows
 *
 * Three of the seven fixtures need an outcome the seeded roster does not
 * produce: a Supplier that resolves to nothing, and a Supplier carrying a
 * disqualifying badge. The spec's instruction is exact — *arranged in the
 * inputs, or tested without a fixture, **never edited into one***.
 *
 * Arranging them means putting rows in front of the pipeline that make the
 * outcome inevitable, and then recording what really happens. It does not mean
 * writing the outcome down.
 *
 * They live in their own Programme so **the approved seed and the boot seed
 * stay untouched**. `seed-facts.test.ts` asserts three findings the write-up
 * stakes its honesty on — that BAT ranks two, that no Supplier sits between
 * 824 km and 6 082 km, that MFN is origin-invariant — and every one of those is
 * a claim about the fifty-row roster. A test fixture that quietly added a
 * fifty-first row would make those numbers wrong and the assertions would say
 * so, which is the right behaviour and the wrong reason.
 *
 * Ids are derived like every other seeded row (finding 40), so a fixture
 * recorded against this Programme replays anywhere.
 */

export const TEST_PROGRAM = {
  id: seedId('program', 'FIXTURE ARRANGEMENTS — test only'),
  name: 'FIXTURE ARRANGEMENTS — test only',
  importingCountry: 'USA',
  vehicleClass: 'Not a real programme; rows arranged so §19.3 outcomes are reachable',
  sourcingHorizon: 'n/a',
} as const;

/**
 * One Category, so the Suppliers have somewhere to bid and the Shortlist reads
 * are not empty. HS 8544.30 matches the real roster's harness line, which keeps
 * the tariff enrichment on a path already proved to work.
 */
export const TEST_CATEGORY = {
  id: seedId('category', 'FIXTURE:ARR'),
  code: 'ARR',
  name: 'Arranged fixtures',
  note: 'Exists so arranged Suppliers can bid somewhere. Not a real category.',
  hsLines: [{ hsCode: '8544.30', label: 'Wire harnesses', rate: 5.0, isDefault: true }],
} as const;

export const TEST_SUPPLIERS = [
  /**
   * **`not_found`, arranged by being unfindable.**
   *
   * A name with no company behind it, in a country the ladder will search. The
   * pre-pass returns candidates or it does not; either way none of them is in
   * DEU under this name, so `sawCandidateInCountry` is false and the settlement
   * is `not_found` rather than `needs_review`.
   *
   * The distinction is the point of the fixture: *nothing in-country was ever
   * seen* is a different ask from *choose among these*, and the Excluded block
   * renders them differently.
   */
  {
    index: 1,
    name: 'Nordhavn Präzisionsteile Vertriebsgesellschaft',
    address: 'Industriestraße 400, 99998 Nordhavn',
    country: 'DEU',
    categories: ['ARR'],
  },
  /**
   * **The disqualifying badge, arranged by naming a sanctioned company.**
   *
   * Rosoboronexport is on every major sanctions list and is unambiguous in the
   * graph, so the badge is a fact about the world rather than a flag we set. A
   * Supplier we marked sanctioned ourselves would prove only that the renderer
   * reads our own column.
   */
  {
    index: 2,
    name: 'Rosoboronexport',
    address: '27 Stromynka Street, Moscow 107076',
    country: 'RUS',
    categories: ['ARR'],
  },
  /**
   * **`needs_review`, arranged by genuine ambiguity.**
   *
   * The Bosch decoy — Syntegon outranking Robert Bosch GmbH on a legal-name
   * query — does not reach the agents at all: the roster row carries an address
   * and a country, the pre-pass uses both, and the auto-accept gate settles it
   * at Round 0 (finding 80). The decoy is real and the gate is simply stronger
   * than it.
   *
   * So the ambiguity has to be in the row. "Sumitomo" alone names at least four
   * large Japanese companies — Electric, Corporation, Chemical, Heavy
   * Industries — and the address below is the Tokyo district several of them
   * share, so it separates none of them. That ambiguity is **a fact about the
   * world**, not a rigged input.
   *
   * What this cannot arrange is *disagreement*. Two agents reading the same
   * ambiguous evidence may still converge, and if they do that is the honest
   * outcome and there is no fixture. `needs_review` is reachable either by the
   * agents failing to converge or by the gate declining with candidates
   * in-country; neither can be compelled.
   */
  {
    index: 3,
    name: 'Sumitomo',
    address: 'Marunouchi, Chiyoda-ku, Tokyo',
    country: 'JPN',
    categories: ['ARR'],
  },
] as const;

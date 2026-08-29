import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as t from '@/db/schema';
import { seed } from '@/db/seed';
import { CATEGORIES, CRITERIA, PLANTS } from '@/db/seed-data/program';
import { ROSTER } from '@/db/seed-data/roster';
import {
  START_TEST_DB_HINT,
  closeTestDb,
  getTestDb,
  testDatabaseIsUp,
  testSql,
  type TestDb,
} from '../support/test-db';

/**
 * SPEC §19.6: `seed-facts.test.ts` asserts the findings the write-up stakes its
 * honesty on.
 *
 * **It breaks if the seed changes, which is correct** — a changed seed means the
 * write-up needs rewriting. That is the point of the file: these are not
 * regression guards on code, they are guards on claims.
 *
 * Two of the write-up's three headline facts cannot be asserted here yet,
 * because they need data a run produces rather than data the seed contains:
 *
 * - *"no Supplier sits between 824 km and 6 082 km"* needs resolved Profiles
 *   with coordinates (build-order step 9).
 * - *"MFN is origin-invariant across every roster country"* needs live USITC
 *   rows (step 9). The seed's own rates are per-line, not per-origin, which is
 *   consistent with the claim but does not prove it.
 *
 * What *is* assertable now is everything the seed itself guarantees, including
 * the structural setup for the first fact: BAT is seeded with three bidders and
 * the write-up says it ranks two.
 */

const up = await testDatabaseIsUp();

describe.skipIf(!up)(`seed facts (needs: ${START_TEST_DB_HINT})`, () => {
  let db: TestDb;
  let programId: string;

  beforeAll(async () => {
    db = await getTestDb();
    // A clean Program each run, so a leftover row cannot make a count pass.
    await testSql()`DELETE FROM program WHERE name = ${'MY2029 Crossover BEV — North America'}`;
    await seed(db);
    const program = await db.query.program.findFirst({
      where: eq(t.program.name, 'MY2029 Crossover BEV — North America'),
    });
    programId = program!.id;
  });

  afterAll(async () => {
    if (!up) return;
    await closeTestDb();
  });

  describe('the roster is 50 rows, and eight of them deliberately fit nothing', () => {
    it('seeds all 50 Suppliers', async () => {
      const rows = await db.query.supplier.findMany({ where: eq(t.supplier.programId, programId) });
      expect(rows).toHaveLength(50);
    });

    it('maps 42 to at least one Category, and keeps eight uncategorised', () => {
      const mapped = ROSTER.filter((r) => r.categories.length > 0);
      expect(mapped).toHaveLength(42);
      expect(ROSTER.filter((r) => r.categories.length === 0).map((r) => r.name)).toEqual([
        'BASF',
        'Tenneco',
        'Infineon Technologies',
        'NTN',
        'Grupo Antolin',
        'DuPont',
        'Visteon',
        'Meritor',
      ]);
    });

    it('walks the uncategorised eight through the lifecycle rather than trimming them', async () => {
      // They are Suppliers of the Program regardless. This is the state that
      // proves the model does not assume every Supplier has a Category.
      const rows = await db.query.supplier.findMany({ where: eq(t.supplier.programId, programId) });
      const links = await testSql()`
        SELECT s.roster_name FROM supplier s
        LEFT JOIN supplier_category sc ON sc.supplier_id = s.id
        WHERE s.program_id = ${programId} AND sc.category_id IS NULL`;
      expect(rows).toHaveLength(50);
      expect(links).toHaveLength(8);
    });
  });

  describe('BAT’s Shortlist is thin, and the write-up says so', () => {
    it('seeds exactly three BAT bidders', () => {
      // Cell and pack manufacturing sits at a different tier than this Tier-1
      // roster, so the field is genuinely small rather than accidentally so.
      // The write-up's claim is that BAT then *ranks two*, because one of the
      // three does not survive resolution — that half is asserted once the
      // resolve loop exists.
      const bat = ROSTER.filter((r) => r.categories.includes('BAT'));
      expect(bat.map((r) => r.name)).toEqual(['Panasonic Automotive', 'Draexlmaier', 'Webasto']);
    });

    it('matches the approved per-Category bidder counts exactly', () => {
      const counts = Object.fromEntries(
        CATEGORIES.map((c) => [c.code, ROSTER.filter((r) => r.categories.includes(c.code)).length]),
      );
      expect(counts).toEqual({
        PWR: 13,
        BRK: 10,
        ENC: 9,
        THM: 9,
        LGT: 7,
        HAR: 6,
        SEA: 6,
        BAT: 3,
      });
    });
  });

  describe('country resilience will discriminate weakly, and that is measured not assumed', () => {
    /**
     * **Correction to SPEC §20 and the seed document, found by this test.**
     *
     * Both say "43 of 50 rows are G7 origins". Counted strictly, it is **42**:
     * DEU 14 + USA 12 + JPN 11 + FRA 3 + CAN 1 + GBR 1, with no Italian row.
     * The 43rd appears to be one of the two Spanish rows counted as
     * high-governance rather than as G7.
     *
     * The claim the number supports is unaffected — 42 strict G7, 44 counting
     * Spain, 47 counting Korea, against a roster of 50 — so the design
     * consequence stands: a min-max stretch across this roster would magnify a
     * rounding difference between Germany and Japan into a visible score gap,
     * which is why normalisation is on a fixed scale.
     *
     * The write-up must quote 42, not 43.
     */
    it('is 42 of 50 strictly-G7 origins — not the 43 the spec states', () => {
      const G7 = new Set(['USA', 'DEU', 'JPN', 'FRA', 'GBR', 'ITA', 'CAN']);
      expect(ROSTER.filter((r) => G7.has(r.country))).toHaveLength(42);
      // 44 once Spain is counted as high-governance, which is the likeliest
      // reading of the seed document's phrase "high-governance G7 origins".
      const HIGH_GOVERNANCE = new Set([...G7, 'ESP']);
      expect(ROSTER.filter((r) => HIGH_GOVERNANCE.has(r.country))).toHaveLength(44);
    });

    it('has the origin spread the seed document records', () => {
      const counts: Record<string, number> = {};
      for (const r of ROSTER) counts[r.country] = (counts[r.country] ?? 0) + 1;
      expect(counts).toEqual({
        DEU: 14,
        USA: 12,
        JPN: 11,
        KOR: 3,
        FRA: 3,
        ESP: 2,
        CAN: 1,
        CHN: 1,
        MEX: 1,
        IND: 1,
        GBR: 1,
      });
    });
  });

  describe('the weight vector is legal', () => {
    it('sums to 100 across exactly six weighted Criteria', async () => {
      const weights = await db.query.programCriterionWeight.findMany({
        where: eq(t.programCriterionWeight.programId, programId),
      });
      expect(weights).toHaveLength(6);
      const total = weights.reduce((sum, w) => sum + Number(w.weight), 0);
      expect(total).toBe(100);
    });

    it('gives Data confidence no weight row at all, because it is a badge', async () => {
      const weights = await db.query.programCriterionWeight.findMany({
        where: eq(t.programCriterionWeight.programId, programId),
      });
      expect(weights.map((w) => w.criterionKey)).not.toContain('data_confidence');
      expect(CRITERIA.find((c) => c.key === 'data_confidence')?.isWeighted).toBe(false);
    });
  });

  describe('every Category resolves to exactly one scored HS line', () => {
    it('has one default line per Category', async () => {
      const rows = await testSql()`
        SELECT c.code, count(*) FILTER (WHERE l.is_default) AS defaults, count(*) AS lines
        FROM category c JOIN category_hs_line l ON l.category_id = c.id
        WHERE c.program_id = ${programId} GROUP BY c.code ORDER BY c.code`;
      expect(rows).toHaveLength(8);
      for (const row of rows) expect(Number(row.defaults)).toBe(1);
    });

    it('carries THM at the 4.2% sub-line rather than the Free heading', () => {
      // 8419.50 is otherwise Free; the battery cold-plate sub-line is the
      // seed's highest rate. Caching the heading would lose the whole finding.
      const thm = CATEGORIES.find((c) => c.code === 'THM')!;
      const scored = thm.hsLines.find((l) => l.isDefault)!;
      expect(scored.hsCode).toBe('8419.50.10.00');
      expect(scored.rate).toBe(4.2);
    });

    it('keeps ENC’s three candidate classifications inside a 0.4-point band', () => {
      // The ambiguity is cheap, which is why ENC gets a real number with a
      // three-line caveat rather than a manual-verify flag.
      const rates = CATEGORIES.find((c) => c.code === 'ENC')!.hsLines.map((l) => l.rate);
      expect(Math.max(...rates) - Math.min(...rates)).toBeCloseTo(0.4, 10);
    });
  });

  describe('the Plants', () => {
    it('seeds four, every one at city precision', async () => {
      const rows = await db.query.plant.findMany({ where: eq(t.plant.programId, programId) });
      expect(rows).toHaveLength(4);
      expect(rows.every((p) => p.precision === 'city')).toBe(true);
    });

    it('includes the Mexican Plant that makes the single importer a proxy', () => {
      const p4 = PLANTS.find((p) => p.code === 'P4')!;
      expect(p4.country).toBe('MEX');
    });
  });

  it('is idempotent — running it twice leaves the same rows', async () => {
    const before = await testSql()`
      SELECT (SELECT count(*) FROM supplier WHERE program_id = ${programId}) AS suppliers,
             (SELECT count(*) FROM supplier_category sc
                JOIN supplier s ON s.id = sc.supplier_id
                WHERE s.program_id = ${programId}) AS links,
             (SELECT count(*) FROM program) AS programs`;
    await seed(db);
    const after = await testSql()`
      SELECT (SELECT count(*) FROM supplier WHERE program_id = ${programId}) AS suppliers,
             (SELECT count(*) FROM supplier_category sc
                JOIN supplier s ON s.id = sc.supplier_id
                WHERE s.program_id = ${programId}) AS links,
             (SELECT count(*) FROM program) AS programs`;
    expect(after[0]).toEqual(before[0]);
  });
});

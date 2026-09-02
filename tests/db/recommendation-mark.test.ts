import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as t from '@/db/schema';
import { publishVersion } from '@/jobs/publish';
import { setRecommendationMark } from '@/jobs/mark-recommendation';
import { loadRecommendationPage } from '@/db/queries/recommendation-page';
import {
  START_TEST_DB_HINT,
  closeTestDb,
  getTestDb,
  testDatabaseIsUp,
  testSql,
  type TestDb,
} from '../support/test-db';

/**
 * The human mark on a Recommendation, against Postgres (CONTEXT.md: *Versioned;
 * a person marks it accepted, rejected or needs work*; SPEC §12.5).
 *
 * Four claims live here, and the database is what makes three of them true
 * rather than merely intended:
 *
 * 1. a mark persists, dated, and changes nothing else about the version;
 * 2. **accepting one version clears the acceptance from its sibling**, and the
 *    partial unique index refuses the two-accepted state even if the writer
 *    forgets;
 * 3. **a Job cannot mark** — `publishVersion` writes `human_mark: null`, and a
 *    re-run leaves an accepted sibling accepted;
 * 4. the page shows the accepted version and says a newer one exists.
 */

const up = await testDatabaseIsUp();

describe.skipIf(!up)(`marking a recommendation (needs: ${START_TEST_DB_HINT})`, () => {
  let db: TestDb;
  let programId: string;
  let categoryId: string;
  let otherCategoryId: string;
  let supplierId: string;
  let criterionValueId: string;

  /**
   * Recommendations first, then the program.
   *
   * `recommendation_pick.supplier_id` is deliberately **not** cascaded, so
   * deleting the program while a pick still names one of its suppliers is
   * refused by the foreign key. Both ends of the fixture wipe the same way, or
   * a failed teardown leaves rows that make the next run's setup fail instead.
   */
  const wipeFixture = async () => {
    const sql = testSql();
    await sql`DELETE FROM recommendation
              WHERE program_id IN (SELECT id FROM program WHERE name = 'mark fixture')`;
    await sql`DELETE FROM program WHERE name = 'mark fixture'`;
  };

  beforeAll(async () => {
    db = await getTestDb();
    const sql = testSql();
    await wipeFixture();
    const [program] = await sql`
      INSERT INTO program (name, importing_country, vehicle_class, sourcing_horizon)
      VALUES ('mark fixture', 'USA', 'BEV', 'FY2027') RETURNING id`;
    programId = program!.id;
    const [category] = await sql`
      INSERT INTO category (program_id, code, name) VALUES (${programId}, 'MRK', 'Marked') RETURNING id`;
    categoryId = category!.id;
    const [other] = await sql`
      INSERT INTO category (program_id, code, name) VALUES (${programId}, 'OTH', 'Other') RETURNING id`;
    otherCategoryId = other!.id;
    const [supplier] = await sql`
      INSERT INTO supplier (program_id, origin, roster_index, roster_name)
      VALUES (${programId}, 'imported', 1, 'Alpha') RETURNING id`;
    supplierId = supplier!.id;
    await sql`INSERT INTO criterion (key, label, blurb, sort_order)
              VALUES ('compliance_risk', 'Compliance risk', 'x', 0) ON CONFLICT DO NOTHING`;
    const [value] = await sql`
      INSERT INTO criterion_value (supplier_id, program_id, criterion_key, value, raw_inputs, anchor_line)
      VALUES (${supplierId}, ${programId}, 'compliance_risk', 92, '{}'::jsonb, 'starts at 100') RETURNING id`;
    criterionValueId = value!.id;
  });

  beforeEach(async () => {
    await testSql()`DELETE FROM recommendation WHERE program_id = ${programId}`;
  });

  afterAll(async () => {
    if (!up) return;
    await wipeFixture();
    await closeTestDb();
  });

  /** One published version, with a pick and a sentence, so "nothing else moved" is checkable. */
  const publish = (text: string, category = categoryId) =>
    publishVersion(db, {
      target: {
        kind: 'recommendation',
        programId,
        categoryId: category,
        picks: [{ supplierId, role: 'award', rank: 1 }],
      },
      sentences: [{ section: 'headline', text, citations: [{ criterionValueId }] }],
      rounds: [],
      dissent: [],
      frozenInputs: {},
      evaluatorOutcome: 'passed',
    });

  const versionRow = async (versionId: string) =>
    db.query.recommendationVersion.findFirst({
      where: eq(t.recommendationVersion.id, versionId),
    });

  describe('a mark is a person’s act, recorded', () => {
    it('persists the mark and the moment it was made', async () => {
      const v1 = await publish('Award Alpha.');
      const before = new Date();

      const outcome = await setRecommendationMark(db, {
        programId,
        categoryId,
        versionId: v1.versionId,
        mark: 'accepted',
      });

      expect(outcome).toMatchObject({ ok: true, versionN: 1, mark: 'accepted' });
      const row = await versionRow(v1.versionId);
      expect(row!.humanMark).toBe('accepted');
      // A mark with no moment is a mark nobody can date, and the header says when.
      expect(row!.humanMarkedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    });

    it('changes no sentence, no pick and not the evaluator’s outcome', async () => {
      const v1 = await publish('Award Alpha.');
      await setRecommendationMark(db, {
        programId,
        categoryId,
        versionId: v1.versionId,
        mark: 'rejected',
      });

      const row = await versionRow(v1.versionId);
      // A person's judgement ABOUT a document is not an edit TO it.
      expect(row!.evaluatorOutcome).toBe('passed');
      const sentences = await db
        .select()
        .from(t.sentence)
        .where(eq(t.sentence.recommendationVersionId, v1.versionId));
      expect(sentences.map((s) => s.text)).toEqual(['Award Alpha.']);
      const picks = await db
        .select()
        .from(t.recommendationPick)
        .where(eq(t.recommendationPick.recommendationVersionId, v1.versionId));
      expect(picks).toHaveLength(1);
    });

    it('takes a mark back without marking something else', async () => {
      const v1 = await publish('Award Alpha.');
      const request = { programId, categoryId, versionId: v1.versionId };
      await setRecommendationMark(db, { ...request, mark: 'needs_work' });
      await setRecommendationMark(db, { ...request, mark: null });

      const row = await versionRow(v1.versionId);
      expect(row!.humanMark).toBeNull();
      // The moment goes with the mark: no date for a decision no longer held.
      expect(row!.humanMarkedAt).toBeNull();
    });

    it('refuses a version belonging to another category’s recommendation', async () => {
      const mine = await publish('Award Alpha.');
      const outcome = await setRecommendationMark(db, {
        programId,
        categoryId: otherCategoryId,
        versionId: mine.versionId,
        mark: 'accepted',
      });

      expect(outcome.ok).toBe(false);
      expect(outcome).toMatchObject({ error: expect.stringContaining('nothing was written') });
      expect((await versionRow(mine.versionId))!.humanMark).toBeNull();
    });

    it('refuses a value that is not an id, rather than throwing a type error', async () => {
      // Postgres answers a non-uuid with a thrown type error, not an empty
      // result, and an action reachable by POST is reachable with any string.
      const outcome = await setRecommendationMark(db, {
        programId,
        categoryId,
        versionId: 'not-an-id',
        mark: 'accepted',
      });
      expect(outcome.ok).toBe(false);
    });
  });

  describe('one accepted version at a time', () => {
    it('clears the acceptance from the sibling when a newer version is accepted', async () => {
      const v1 = await publish('First.');
      const v2 = await publish('Second.');
      await setRecommendationMark(db, {
        programId,
        categoryId,
        versionId: v1.versionId,
        mark: 'accepted',
      });

      const outcome = await setRecommendationMark(db, {
        programId,
        categoryId,
        versionId: v2.versionId,
        mark: 'accepted',
      });

      expect(outcome).toMatchObject({ ok: true, clearedFrom: [1] });
      const first = await versionRow(v1.versionId);
      expect(first!.humanMark).toBeNull();
      expect(first!.humanMarkedAt).toBeNull();
      expect((await versionRow(v2.versionId))!.humanMark).toBe('accepted');
    });

    it('leaves a rejected sibling rejected — only acceptance is exclusive', async () => {
      const v1 = await publish('First.');
      const v2 = await publish('Second.');
      await setRecommendationMark(db, {
        programId,
        categoryId,
        versionId: v1.versionId,
        mark: 'rejected',
      });
      await setRecommendationMark(db, {
        programId,
        categoryId,
        versionId: v2.versionId,
        mark: 'accepted',
      });

      // Clearing it would be this action editing a judgement nobody asked it about.
      expect((await versionRow(v1.versionId))!.humanMark).toBe('rejected');
    });

    it('REFUSES two accepted versions at the database, not merely in the writer', async () => {
      const v1 = await publish('First.');
      const v2 = await publish('Second.');
      await testSql()`UPDATE recommendation_version SET human_mark = 'accepted' WHERE id = ${v1.versionId}`;

      // The partial unique index is what makes "the accepted one" unambiguous
      // even if the writer above ever forgets to clear the sibling.
      await expect(
        testSql()`UPDATE recommendation_version SET human_mark = 'accepted' WHERE id = ${v2.versionId}`,
      ).rejects.toThrow(/recommendation_version_one_accepted_key/);
    });
  });

  describe('a Job never marks', () => {
    it('publishes every version unmarked', async () => {
      const v1 = await publish('Award Alpha.');
      const row = await versionRow(v1.versionId);
      // An agent that could accept a Recommendation could accept its own.
      expect(row!.humanMark).toBeNull();
      expect(row!.humanMarkedAt).toBeNull();
    });

    it('does not clear an accepted mark by re-running', async () => {
      const v1 = await publish('First.');
      await setRecommendationMark(db, {
        programId,
        categoryId,
        versionId: v1.versionId,
        mark: 'accepted',
      });

      // A re-run always versions, and this is the version it writes.
      await publish('Second.');

      expect((await versionRow(v1.versionId))!.humanMark).toBe('accepted');
    });
  });

  describe('the page shows what a person accepted', () => {
    it('prefers the accepted version and reports the newer sibling', async () => {
      const v1 = await publish('First.');
      const v2 = await publish('Second.');
      await setRecommendationMark(db, {
        programId,
        categoryId,
        versionId: v1.versionId,
        mark: 'accepted',
      });

      const page = await loadRecommendationPage(db, { programId, categoryId });

      expect(page!.version!.id).toBe(v1.versionId);
      expect(page!.newer).toBe(1);
      expect(page!.latest!.id).toBe(v2.versionId);
      expect(page!.pinned).toBe(false);
      // The argument on screen is the accepted version's, not the newest one's.
      expect(page!.sentences.map((s) => s.text)).toEqual(['First.']);
      // A version list is a list of decisions, so each row carries its mark.
      expect(page!.versions.map((v) => [v.n, v.humanMark])).toEqual([
        [2, null],
        [1, 'accepted'],
      ]);
    });

    it('shows the latest when nobody has accepted anything', async () => {
      await publish('First.');
      const v2 = await publish('Second.');

      const page = await loadRecommendationPage(db, { programId, categoryId });
      expect(page!.version!.id).toBe(v2.versionId);
      expect(page!.newer).toBe(0);
    });

    it('lets a reader ask for the newer version by number, and says they did', async () => {
      const v1 = await publish('First.');
      const v2 = await publish('Second.');
      await setRecommendationMark(db, {
        programId,
        categoryId,
        versionId: v1.versionId,
        mark: 'accepted',
      });

      // Without this, "acceptance never moves" would make the newer argument
      // unreadable in the app that wrote it.
      const page = await loadRecommendationPage(db, { programId, categoryId, versionN: 2 });
      expect(page!.version!.id).toBe(v2.versionId);
      expect(page!.pinned).toBe(true);
      expect(page!.sentences.map((s) => s.text)).toEqual(['Second.']);
    });

    it('falls back to the rule for a version number that names nothing', async () => {
      const v1 = await publish('First.');
      await setRecommendationMark(db, {
        programId,
        categoryId,
        versionId: v1.versionId,
        mark: 'accepted',
      });

      const page = await loadRecommendationPage(db, { programId, categoryId, versionN: 99 });
      expect(page!.version!.id).toBe(v1.versionId);
      expect(page!.pinned).toBe(false);
    });
  });
});

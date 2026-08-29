import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import * as t from '@/db/schema';
import { citationKey, publishVersion, resolveCitations, versionToShow } from '@/jobs/publish';
import {
  START_TEST_DB_HINT,
  closeTestDb,
  getTestDb,
  testDatabaseIsUp,
  testSql,
  type TestDb,
} from '../support/test-db';

/**
 * SPEC §10.6 and §12.5, end to end against Postgres.
 *
 * The unit tests prove the checks reject; this proves what happens when they
 * pass — that a version, its sentences, its citations and its Rounds land
 * together, and that the database refuses anything the checks would have.
 */

const up = await testDatabaseIsUp();

describe.skipIf(!up)(`publishing a version (needs: ${START_TEST_DB_HINT})`, () => {
  let db: TestDb;
  let programId: string;
  let categoryId: string;
  let supplierId: string;
  let criterionValueId: string;

  beforeAll(async () => {
    db = await getTestDb();
    const sql = testSql();
    await sql`DELETE FROM program WHERE name = 'publish fixture'`;
    const [program] = await sql`
      INSERT INTO program (name, importing_country, vehicle_class, sourcing_horizon)
      VALUES ('publish fixture', 'USA', 'BEV', 'FY2027') RETURNING id`;
    programId = program!.id;
    const [category] = await sql`
      INSERT INTO category (program_id, code, name) VALUES (${programId}, 'PUB', 'Publish') RETURNING id`;
    categoryId = category!.id;
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
    await testSql()`DELETE FROM assessment WHERE program_id = ${programId}`;
    await testSql()`DELETE FROM recommendation WHERE program_id = ${programId}`;
  });

  afterAll(async () => {
    if (!up) return;
    await testSql()`DELETE FROM program WHERE name = 'publish fixture'`;
    await closeTestDb();
  });

  describe('resolveCitations returns a live row, or nothing', () => {
    it('resolves a criterion value that exists', async () => {
      const resolved = await resolveCitations(db, [{ criterionValueId }]);
      expect(resolved.get(citationKey({ criterionValueId }))).toBeDefined();
    });

    it('returns undefined for a row that does not exist — an objection, not a crash', async () => {
      const missing = { criterionValueId: '00000000-0000-0000-0000-000000000000' };
      const resolved = await resolveCitations(db, [missing]);
      expect(resolved.get(citationKey(missing))).toBeUndefined();
    });

    it('resolves a shortlist reference only when BOTH halves exist', async () => {
      const whole = { shortlist: { programId, categoryId } };
      expect((await resolveCitations(db, [whole])).get(citationKey(whole))).toBeDefined();

      const mismatched = { shortlist: { programId, categoryId: '00000000-0000-0000-0000-000000000000' } };
      expect((await resolveCitations(db, [mismatched])).get(citationKey(mismatched))).toBeUndefined();
    });

    it('returns undefined for a citation with no target group at all', async () => {
      // The database CHECK would refuse it; catching it here means the model
      // gets an objection rather than a constraint error.
      expect((await resolveCitations(db, [{}])).get(citationKey({}))).toBeUndefined();
    });
  });

  describe('an assessment version lands whole', () => {
    it('writes the version, its sentences, its citations and its rounds together', async () => {
      const { versionId, n } = await publishVersion(db, {
        target: { kind: 'assessment', supplierId, programId, verdict: 'recommend' },
        sentences: [
          { section: 'identity', text: 'Alpha is the company at the roster address.', citations: [{ criterionValueId }] },
          { section: 'limits', text: 'Proximity is unknown.', citations: [{ criterionValueId }] },
        ],
        rounds: [
          { n: 1, role: 'proposer', source: 'model', text: 'draft' },
          { n: 1, role: 'evaluator', source: 'model', text: 'ok', rubric: { support: 'pass' } },
        ],
        dissent: [],
        frozenInputs: { scores: { alpha: 84.2 } },
        evaluatorOutcome: 'passed',
      });

      expect(n).toBe(1);
      const sentences = await db.select().from(t.sentence).where(eq(t.sentence.assessmentVersionId, versionId));
      expect(sentences).toHaveLength(2);
      const citations = await testSql()`
        SELECT count(*)::int AS n FROM citation c
        JOIN sentence s ON s.id = c.sentence_id WHERE s.assessment_version_id = ${versionId}`;
      expect(citations[0]!.n).toBe(2);
      const rounds = await db.select().from(t.round).where(eq(t.round.assessmentVersionId, versionId));
      expect(rounds).toHaveLength(2);
    });

    it('numbers sentences per section rather than globally', async () => {
      const { versionId } = await publishVersion(db, {
        target: { kind: 'assessment', supplierId, programId, verdict: 'recommend' },
        sentences: [
          { section: 'identity', text: 'One.', citations: [{ criterionValueId }] },
          { section: 'limits', text: 'Two.', citations: [{ criterionValueId }] },
          { section: 'limits', text: 'Three.', citations: [{ criterionValueId }] },
        ],
        rounds: [],
        dissent: [],
        frozenInputs: {},
        evaluatorOutcome: 'passed',
      });
      const limits = await db
        .select()
        .from(t.sentence)
        .where(eq(t.sentence.assessmentVersionId, versionId));
      const ordinals = limits.filter((s) => s.section === 'limits').map((s) => s.ordinal).sort();
      expect(ordinals).toEqual([1, 2]);
    });

    it('ROLLS BACK ENTIRELY when a citation turns out not to resolve', async () => {
      // The database CHECK is the last line of defence and is meant never to
      // fire. If it does, nothing lands half-written.
      await expect(
        publishVersion(db, {
          target: { kind: 'assessment', supplierId, programId, verdict: 'recommend' },
          sentences: [
            { section: 'identity', text: 'Alpha.', citations: [{ entityId: 'no-such-entity' }] },
          ],
          rounds: [],
          dissent: [],
          frozenInputs: {},
          evaluatorOutcome: 'passed',
        }),
      ).rejects.toThrow();

      const assessments = await db.select().from(t.assessment).where(eq(t.assessment.programId, programId));
      expect(assessments).toHaveLength(0);
    });

    it('ALWAYS versions on a re-run, even when the text is identical', async () => {
      // "The weights changed and the argument didn't" is the most interesting
      // thing the diff can say, so there is no de-duplication here.
      const payload = {
        target: { kind: 'assessment' as const, supplierId, programId, verdict: 'recommend' },
        sentences: [{ section: 'identity', text: 'Identical.', citations: [{ criterionValueId }] }],
        rounds: [],
        dissent: [],
        frozenInputs: {},
        evaluatorOutcome: 'passed' as const,
      };
      const first = await publishVersion(db, payload);
      const second = await publishVersion(db, payload);
      expect(first.n).toBe(1);
      expect(second.n).toBe(2);
    });

    it('allows a null verdict, which is what a Dossier needs', async () => {
      const { versionId } = await publishVersion(db, {
        target: { kind: 'assessment', supplierId, programId, verdict: null, assessmentKind: 'dossier' },
        sentences: [{ section: 'identity', text: 'A dossier.', citations: [{ criterionValueId }] }],
        rounds: [],
        dissent: [],
        frozenInputs: {},
        evaluatorOutcome: 'passed',
      });
      const version = await db.query.assessmentVersion.findFirst({ where: eq(t.assessmentVersion.id, versionId) });
      expect(version!.verdict).toBeNull();
    });
  });

  describe('a recommendation version', () => {
    it('writes typed picks and attaches conditions to them', async () => {
      const { versionId } = await publishVersion(db, {
        target: { kind: 'recommendation', programId, categoryId, picks: [{ supplierId, role: 'award', rank: 1 }] },
        sentences: [
          { section: 'headline', text: 'Award Alpha.', citations: [{ criterionValueId }] },
          {
            section: 'conditions',
            text: 'Conditional on a site audit.',
            citations: [{ criterionValueId }],
            pickSupplierId: supplierId,
          },
        ],
        rounds: [],
        dissent: [],
        frozenInputs: {},
        evaluatorOutcome: 'passed',
      });

      const picks = await db
        .select()
        .from(t.recommendationPick)
        .where(eq(t.recommendationPick.recommendationVersionId, versionId));
      expect(picks).toHaveLength(1);

      const condition = await db
        .select()
        .from(t.sentence)
        .where(eq(t.sentence.recommendationVersionId, versionId));
      expect(condition.find((s) => s.section === 'conditions')!.pickId).toBe(picks[0]!.id);
    });

    it('shows the most recent ACCEPTED version, not the latest', async () => {
      // Acceptance never moves: a re-run does not silently replace a decision
      // somebody made.
      const payload = (text: string) => ({
        target: { kind: 'recommendation' as const, programId, categoryId, picks: [] },
        sentences: [{ section: 'headline', text, citations: [{ criterionValueId }] }],
        rounds: [],
        dissent: [],
        frozenInputs: {},
        evaluatorOutcome: 'passed' as const,
      });
      const v1 = await publishVersion(db, payload('First.'));
      await testSql()`UPDATE recommendation_version SET human_mark = 'accepted' WHERE id = ${v1.versionId}`;
      await publishVersion(db, payload('Second.'));

      const recommendation = await db.query.recommendation.findFirst({
        where: eq(t.recommendation.programId, programId),
      });
      const { shown, newer } = await versionToShow(db, recommendation!.id);
      expect(shown!.id).toBe(v1.versionId);
      // And the page carries a strip naming the newer one.
      expect(newer).toBe(1);
    });

    it('shows the latest when nothing has been accepted', async () => {
      const payload = (text: string) => ({
        target: { kind: 'recommendation' as const, programId, categoryId, picks: [] },
        sentences: [{ section: 'headline', text, citations: [{ criterionValueId }] }],
        rounds: [],
        dissent: [],
        frozenInputs: {},
        evaluatorOutcome: 'passed' as const,
      });
      await publishVersion(db, payload('First.'));
      const v2 = await publishVersion(db, payload('Second.'));
      const recommendation = await db.query.recommendation.findFirst({
        where: eq(t.recommendation.programId, programId),
      });
      const { shown, newer } = await versionToShow(db, recommendation!.id);
      expect(shown!.id).toBe(v2.versionId);
      expect(newer).toBe(0);
    });
  });

  describe('dissent is stored as rounds, never as a section', () => {
    it('keeps the objection and the reply it drew', async () => {
      const { versionId } = await publishVersion(db, {
        target: { kind: 'assessment', supplierId, programId, verdict: 'recommend' },
        sentences: [{ section: 'identity', text: 'Alpha.', citations: [{ criterionValueId }] }],
        rounds: [
          { n: 3, role: 'evaluator', source: 'model', objection: 'the ownership claim is beyond the record', reply: 'we softened it' },
        ],
        dissent: [{ objection: 'the ownership claim is beyond the record', reply: 'we softened it' }],
        frozenInputs: {},
        evaluatorOutcome: 'published_with_objections',
      });

      const rounds = await db
        .select()
        .from(t.round)
        .where(eq(t.round.assessmentVersionId, versionId))
        .orderBy(desc(t.round.n));
      expect(rounds[0]!.objection).toMatch(/beyond the record/);
      expect(rounds[0]!.reply).toBe('we softened it');

      // There is no `dissent` sentence: nobody writes dissent.
      const sentences = await db.select().from(t.sentence).where(eq(t.sentence.assessmentVersionId, versionId));
      expect(sentences.some((s) => s.section === 'dissent')).toBe(false);
    });
  });
});

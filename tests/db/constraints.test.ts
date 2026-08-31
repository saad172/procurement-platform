import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  START_TEST_DB_HINT,
  closeTestDb,
  getTestDb,
  testDatabaseIsUp,
  testSql,
} from '../support/test-db';

/**
 * The database chokepoint (SPEC §2.4).
 *
 * Three of the four structural chokepoints are import boundaries; this is the
 * fourth kind — a constraint rather than a lint rule. `citation` carries
 * exactly one target group under a one-of CHECK, and every group is a foreign
 * key, **so a dangling Citation cannot be inserted**.
 *
 * That is a stronger claim than "a validator catches it", and it deserves a
 * test that proves the write is refused rather than that some code path checks.
 * These tests are the only place the claim is verified, so each `expect` is
 * asserting a property the rest of the build assumes.
 */

const up = await testDatabaseIsUp();

describe.skipIf(!up)(`database constraints (needs: ${START_TEST_DB_HINT})`, () => {
  /** Ids are fixed so a failure names the row it failed on. */
  const PROGRAM = '11111111-1111-1111-1111-111111111111';
  const CATEGORY = '1c1c1c1c-1111-1111-1111-111111111111';
  const SUPPLIER = '22222222-2222-2222-2222-222222222222';
  const ASSESSMENT = '33333333-3333-3333-3333-333333333333';
  const VERSION = '44444444-4444-4444-4444-444444444444';
  const SENTENCE = '55555555-5555-5555-5555-555555555555';

  beforeAll(async () => {
    await getTestDb();
    const sql = testSql();
    // A minimal but *legal* graph, so every failure below is the constraint
    // under test and not a missing parent row.
    await sql`DELETE FROM program WHERE id = ${PROGRAM}`;
    await sql`INSERT INTO program (id, name, importing_country, vehicle_class, sourcing_horizon)
              VALUES (${PROGRAM}, 'Constraint fixture', 'USA', 'BEV', 'FY2027')`;
    await sql`INSERT INTO category (id, program_id, code, name)
              VALUES (${CATEGORY}, ${PROGRAM}, 'TST', 'Test category')`;
    await sql`INSERT INTO supplier (id, program_id, origin, roster_index, roster_name)
              VALUES (${SUPPLIER}, ${PROGRAM}, 'imported', 1, 'Fixture Supplier')`;
    await sql`INSERT INTO assessment (id, supplier_id, program_id)
              VALUES (${ASSESSMENT}, ${SUPPLIER}, ${PROGRAM})`;
    await sql`INSERT INTO assessment_version (id, assessment_id, n, frozen_inputs, evaluator_outcome)
              VALUES (${VERSION}, ${ASSESSMENT}, 1, '{}'::jsonb, 'passed')`;
    await sql`INSERT INTO sentence (id, assessment_version_id, section, ordinal, text)
              VALUES (${SENTENCE}, ${VERSION}, 'identity', 1, 'A cited sentence.')`;
  });

  afterAll(async () => {
    if (!up) return;
    await testSql()`DELETE FROM program WHERE id = ${PROGRAM}`;
    await closeTestDb();
  });

  describe('a dangling Citation cannot be inserted', () => {
    it('refuses a Citation with no target at all', async () => {
      await expect(
        testSql()`INSERT INTO citation (sentence_id) VALUES (${SENTENCE})`,
      ).rejects.toThrow(/citation_exactly_one_target_group/);
    });

    it('refuses a Citation carrying two target groups', async () => {
      await expect(
        testSql()`INSERT INTO citation (sentence_id, match_id, enrichment_id)
                  VALUES (${SENTENCE}, gen_random_uuid(), gen_random_uuid())`,
      ).rejects.toThrow(/citation_exactly_one_target_group/);
    });

    it('refuses a Citation pointing at an entity that does not exist', async () => {
      // The foreign key, not the CHECK: "exactly one group" and "that group
      // resolves" are two different guarantees and both are needed.
      await expect(
        testSql()`INSERT INTO citation (sentence_id, entity_id)
                  VALUES (${SENTENCE}, 'no-such-entity')`,
      ).rejects.toThrow(/foreign key|citation_entity_id/i);
    });

    it('refuses half a Shortlist reference, because the pair is one group', async () => {
      await expect(
        testSql()`INSERT INTO citation (sentence_id, shortlist_program_id)
                  VALUES (${SENTENCE}, ${PROGRAM})`,
      ).rejects.toThrow(/citation_shortlist_pair_is_whole|citation_exactly_one_target_group/);
    });

    it('accepts a whole Shortlist reference', async () => {
      const [row] = await testSql()`
        INSERT INTO citation (sentence_id, shortlist_program_id, shortlist_category_id)
        VALUES (${SENTENCE}, ${PROGRAM}, ${CATEGORY}) RETURNING id`;
      expect(row?.id).toBeTruthy();
    });
  });

  describe('a sentence belongs to exactly one document', () => {
    it('refuses a sentence owned by neither', async () => {
      await expect(
        testSql()`INSERT INTO sentence (section, ordinal, text)
                  VALUES ('identity', 2, 'orphan')`,
      ).rejects.toThrow(/sentence_one_owner/);
    });

    it('refuses a pick reference outside the conditions section', async () => {
      await expect(
        testSql()`INSERT INTO sentence (assessment_version_id, section, ordinal, text, pick_id)
                  VALUES (${VERSION}, 'identity', 3, 'x', gen_random_uuid())`,
      ).rejects.toThrow(/sentence_pick_only_in_conditions/);
    });
  });

  describe('origin and roster columns stay consistent', () => {
    it('refuses a discovered Supplier carrying a roster row', async () => {
      await expect(
        testSql()`INSERT INTO supplier (program_id, origin, roster_index, roster_name)
                  VALUES (${PROGRAM}, 'discovered', 9, 'Promoted Lead')`,
      ).rejects.toThrow(/supplier_origin_roster_consistency/);
    });

    it('refuses an imported Supplier with no roster row', async () => {
      await expect(
        testSql()`INSERT INTO supplier (program_id, origin) VALUES (${PROGRAM}, 'imported')`,
      ).rejects.toThrow(/supplier_origin_roster_consistency/);
    });

    it('accepts a discovered Supplier with no roster row', async () => {
      const [row] = await testSql()`
        INSERT INTO supplier (program_id, origin) VALUES (${PROGRAM}, 'discovered') RETURNING id`;
      expect(row?.id).toBeTruthy();
    });
  });

  describe('a Round belongs to exactly one loop', () => {
    it('refuses a Round owned by nothing', async () => {
      await expect(
        testSql()`INSERT INTO round (n, role, source) VALUES (1, 'proposer', 'model')`,
      ).rejects.toThrow(/round_one_owner/);
    });
  });

  describe('two Suppliers may resolve to one entity', () => {
    it('does not constrain match.entity_id to be unique', async () => {
      const sql = testSql();
      await sql`INSERT INTO entity (id, label) VALUES ('shared-entity', 'Shared Co')
                ON CONFLICT (id) DO NOTHING`;
      const [a] = await sql`INSERT INTO supplier (program_id, origin, roster_index, roster_name)
                            VALUES (${PROGRAM}, 'imported', 101, 'Brand name') RETURNING id`;
      const [b] = await sql`INSERT INTO supplier (program_id, origin, roster_index, roster_name)
                            VALUES (${PROGRAM}, 'imported', 102, 'Legal name') RETURNING id`;
      await sql`INSERT INTO match (supplier_id, status, entity_id, settled_by)
                VALUES (${a!.id}, 'accepted', 'shared-entity', 'agents')`;
      // The second write is the assertion: a brand-name row and a legal-entity
      // row colliding on one company is correct, and surfaces as a Shortlist
      // finding rather than a write failure (SPEC §3.3).
      const [second] = await sql`INSERT INTO match (supplier_id, status, entity_id, settled_by)
                                 VALUES (${b!.id}, 'accepted', 'shared-entity', 'agents')
                                 RETURNING id`;
      expect(second?.id).toBeTruthy();
    });
  });
});

/**
 * **A family member is a fact about the ownership graph, not about the read
 * that found it.**
 *
 * `family_member` carried only its `id` primary key, so the insert's
 * `onConflictDoNothing()` conflicted on a freshly generated uuid and therefore
 * never fired. A second enrichment of the same Profile inserted the whole
 * family again: Bosch and Magna each held **100 rows for 50 distinct
 * members**, and both the supplier page and `get_supplier_family` counted rows
 * to report coverage. The badge read *"28 of 100 explored"* where the truth was
 * 14 of 50 — both halves doubled, in the same direction, so nothing looked odd.
 *
 * The constraint is what makes re-enrichment idempotent rather than merely
 * repeated, and it is the reason the row count and `explored_count` cannot
 * silently drift apart again.
 */
describe.skipIf(!up)(`one family_member row per (root, member) (needs: ${START_TEST_DB_HINT})`, () => {
  const ROOT = 'family-constraint-root';
  const MEMBER = 'family-constraint-member';
  const RESPONSE = '66666666-6666-6666-6666-666666666666';
  const ENRICHMENT_A = '77777777-7777-7777-7777-777777777777';
  const ENRICHMENT_B = '88888888-8888-8888-8888-888888888888';

  beforeAll(async () => {
    // The block above closes the client in its own `afterAll`, so this reopens.
    await getTestDb();
    const sql = testSql();
    await sql`DELETE FROM entity WHERE id IN (${ROOT}, ${MEMBER})`;
    await sql`INSERT INTO entity (id, label) VALUES (${ROOT}, 'Root'), (${MEMBER}, 'Member')`;
    await sql`INSERT INTO upstream_response (id, source, endpoint, params_hash, params, body, body_hash, via)
              VALUES (${RESPONSE}, 'sayari', 'traversal.ownership', 'h', '{}'::jsonb, '{}'::jsonb, 'bh', 'sdk')`;
    // Two enrichments of the same Profile: the exact shape that doubled the
    // family, since re-enrichment is a button a person can press twice.
    for (const id of [ENRICHMENT_A, ENRICHMENT_B]) {
      await sql`INSERT INTO enrichment (id, source, subject_kind, subject_key, request_params, upstream_response_id)
                VALUES (${id}, 'sayari_ownership_family', 'entity', ${ROOT}, '{}'::jsonb, ${RESPONSE})`;
    }
  });

  afterAll(async () => {
    if (!up) return;
    const sql = testSql();
    await sql`DELETE FROM enrichment WHERE id IN (${ENRICHMENT_A}, ${ENRICHMENT_B})`;
    await sql`DELETE FROM upstream_response WHERE id = ${RESPONSE}`;
    await sql`DELETE FROM entity WHERE id IN (${ROOT}, ${MEMBER})`;
    await closeTestDb();
  });

  it('refuses the same member twice under the same root', async () => {
    const sql = testSql();
    await sql`INSERT INTO family_member (enrichment_id, root_entity_id, member_entity_id, hop_depth, explored_count)
              VALUES (${ENRICHMENT_A}, ${ROOT}, ${MEMBER}, 1, 50)`;
    await expect(
      sql`INSERT INTO family_member (enrichment_id, root_entity_id, member_entity_id, hop_depth, explored_count)
          VALUES (${ENRICHMENT_B}, ${ROOT}, ${MEMBER}, 1, 50)`,
    ).rejects.toThrow(/family_member_root_member_key/);
  });

  it('lets a second read refresh the row it already has', async () => {
    // What `enrichFamily` now does: the pair is the identity, and a re-read is
    // newer evidence about the same pair rather than a new fact.
    const sql = testSql();
    await sql`INSERT INTO family_member (enrichment_id, root_entity_id, member_entity_id, hop_depth, explored_count)
              VALUES (${ENRICHMENT_B}, ${ROOT}, ${MEMBER}, 2, 37)
              ON CONFLICT (root_entity_id, member_entity_id)
              DO UPDATE SET enrichment_id = EXCLUDED.enrichment_id,
                            hop_depth = EXCLUDED.hop_depth,
                            explored_count = EXCLUDED.explored_count`;
    const rows = await sql`SELECT hop_depth, explored_count FROM family_member
                           WHERE root_entity_id = ${ROOT} AND member_entity_id = ${MEMBER}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ hop_depth: 2, explored_count: 37 });
  });
});

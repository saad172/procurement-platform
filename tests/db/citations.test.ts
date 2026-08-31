import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSentenceEvidence } from '@/db/queries/citations';
import {
  START_TEST_DB_HINT,
  closeTestDb,
  getTestDb,
  testDatabaseIsUp,
  testSql,
} from '../support/test-db';

/**
 * **A Citation is a hop, and a hop needs somewhere to land** (SPEC §13.7).
 *
 * The `❡` after every published sentence pointed at
 * `/program/…/supplier/…/citation/[sentenceId]`, a route that was never
 * written: **169 live links, every one a 404**, across the three Assessments
 * published so far. The evidence was never the missing part — all 169
 * sentences carry at least one Citation, 236 in total.
 *
 * These tests cover the resolver rather than the page, because the resolver is
 * where the interesting claims are: that every one of the six target kinds the
 * `citation` one-of CHECK allows renders rather than vanishing, that a
 * Programme in the URL cannot reach another Programme's sentence, and that a
 * Citation whose row is gone says so instead of disappearing.
 */

const up = await testDatabaseIsUp();

describe.skipIf(!up)(`resolving what a sentence cites (needs: ${START_TEST_DB_HINT})`, () => {
  const PROGRAM = 'aaaa1111-1111-1111-1111-111111111111';
  const OTHER_PROGRAM = 'aaaa2222-2222-2222-2222-222222222222';
  const CATEGORY = 'bbbb1111-1111-1111-1111-111111111111';
  const SUPPLIER = 'cccc1111-1111-1111-1111-111111111111';
  const OTHER_SUPPLIER = 'cccc2222-2222-2222-2222-222222222222';
  const ASSESSMENT = 'dddd1111-1111-1111-1111-111111111111';
  const OTHER_ASSESSMENT = 'dddd2222-2222-2222-2222-222222222222';
  const VERSION = 'eeee1111-1111-1111-1111-111111111111';
  const OTHER_VERSION = 'eeee2222-2222-2222-2222-222222222222';
  const SENTENCE = 'ffff1111-1111-1111-1111-111111111111';
  const OTHER_SENTENCE = 'ffff2222-2222-2222-2222-222222222222';
  const RESPONSE = '0a0a1111-1111-1111-1111-111111111111';
  const ENRICHMENT = '0b0b1111-1111-1111-1111-111111111111';
  const CRITERION_VALUE = '0c0c1111-1111-1111-1111-111111111111';
  const MATCH = '0d0d1111-1111-1111-1111-111111111111';
  const ENTITY = 'citation-target-entity';
  const RECORD = 'src-hash/{93635462-94C0}/1672531200000';

  beforeAll(async () => {
    await getTestDb();
    const sql = testSql();
    await sql`DELETE FROM program WHERE id IN (${PROGRAM}, ${OTHER_PROGRAM})`;
    await sql`DELETE FROM entity WHERE id = ${ENTITY}`;

    for (const [id, name] of [[PROGRAM, 'Citation fixture'], [OTHER_PROGRAM, 'Another programme']]) {
      await sql`INSERT INTO program (id, name, importing_country, vehicle_class, sourcing_horizon)
                VALUES (${id!}, ${name!}, 'USA', 'BEV', 'FY2027')`;
    }
    await sql`INSERT INTO category (id, program_id, code, name)
              VALUES (${CATEGORY}, ${PROGRAM}, 'BAT', 'Battery pack assembly')`;
    await sql`INSERT INTO supplier (id, program_id, origin, roster_index, roster_name)
              VALUES (${SUPPLIER}, ${PROGRAM}, 'imported', 1, 'Fixture Supplier')`;
    await sql`INSERT INTO supplier (id, program_id, origin, roster_index, roster_name)
              VALUES (${OTHER_SUPPLIER}, ${OTHER_PROGRAM}, 'imported', 1, 'Other Supplier')`;
    await sql`INSERT INTO entity (id, label, entity_type, country)
              VALUES (${ENTITY}, 'ROBERT BOSCH GMBH', 'company', 'DEU')`;
    await sql`INSERT INTO upstream_response (id, source, endpoint, params_hash, params, body, body_hash, via)
              VALUES (${RESPONSE}, 'sayari', 'entity.getEntity', 'h', '{}'::jsonb, '{}'::jsonb, 'bh', 'sdk')`;
    await sql`INSERT INTO record (id, source, source_label)
              VALUES (${RECORD}, 'de_handelsregister', 'German commercial register')`;
    await sql`INSERT INTO enrichment (id, source, subject_kind, subject_key, request_params, upstream_response_id)
              VALUES (${ENRICHMENT}, 'sayari_negative_news', 'entity', ${ENTITY}, '{}'::jsonb, ${RESPONSE})`;
    await sql`INSERT INTO criterion_value (id, supplier_id, program_id, criterion_key, value, raw_inputs, anchor_line)
              VALUES (${CRITERION_VALUE}, ${SUPPLIER}, ${PROGRAM}, 'compliance_risk', 60,
                      '{}'::jsonb, 'starts at 100; high −40, elevated −20, relevant −8, floored at 0')`;
    await sql`INSERT INTO match (id, supplier_id, entity_id, status, settled_by)
              VALUES (${MATCH}, ${SUPPLIER}, ${ENTITY}, 'accepted', 'rules')`;

    for (const [a, s, v] of [
      [ASSESSMENT, SUPPLIER, VERSION],
      [OTHER_ASSESSMENT, OTHER_SUPPLIER, OTHER_VERSION],
    ]) {
      await sql`INSERT INTO assessment (id, supplier_id, program_id)
                VALUES (${a!}, ${s!}, ${s === SUPPLIER ? PROGRAM : OTHER_PROGRAM})`;
      await sql`INSERT INTO assessment_version (id, assessment_id, n, frozen_inputs, evaluator_outcome)
                VALUES (${v!}, ${a!}, 1, '{}'::jsonb, 'passed')`;
    }
    await sql`INSERT INTO sentence (id, assessment_version_id, section, ordinal, text)
              VALUES (${SENTENCE}, ${VERSION}, 'identity', 1, 'A sentence resting on five things.')`;
    await sql`INSERT INTO sentence (id, assessment_version_id, section, ordinal, text)
              VALUES (${OTHER_SENTENCE}, ${OTHER_VERSION}, 'identity', 1, 'Another programme''s sentence.')`;

    // One of every target group the one-of CHECK allows, on one sentence.
    await sql`INSERT INTO citation (sentence_id, entity_id) VALUES (${SENTENCE}, ${ENTITY})`;
    await sql`INSERT INTO citation (sentence_id, record_id) VALUES (${SENTENCE}, ${RECORD})`;
    await sql`INSERT INTO citation (sentence_id, enrichment_id) VALUES (${SENTENCE}, ${ENRICHMENT})`;
    await sql`INSERT INTO citation (sentence_id, criterion_value_id) VALUES (${SENTENCE}, ${CRITERION_VALUE})`;
    await sql`INSERT INTO citation (sentence_id, match_id) VALUES (${SENTENCE}, ${MATCH})`;
    await sql`INSERT INTO citation (sentence_id, shortlist_program_id, shortlist_category_id)
              VALUES (${SENTENCE}, ${PROGRAM}, ${CATEGORY})`;
  });

  afterAll(async () => {
    if (!up) return;
    const sql = testSql();
    await sql`DELETE FROM citation WHERE sentence_id IN (${SENTENCE}, ${OTHER_SENTENCE})`;
    await sql`DELETE FROM program WHERE id IN (${PROGRAM}, ${OTHER_PROGRAM})`;
    await sql`DELETE FROM record WHERE id = ${RECORD}`;
    await sql`DELETE FROM enrichment WHERE id = ${ENRICHMENT}`;
    await sql`DELETE FROM upstream_response WHERE id = ${RESPONSE}`;
    await sql`DELETE FROM entity WHERE id = ${ENTITY}`;
    await closeTestDb();
  });

  it('resolves every target kind the one-of CHECK allows', async () => {
    const db = await getTestDb();
    const evidence = await loadSentenceEvidence(db, { programId: PROGRAM, sentenceId: SENTENCE });

    expect(evidence).not.toBeNull();
    // All six, because a Citation kind appearing for the first time should
    // render rather than vanish — three of the six have never been written yet.
    expect(evidence!.citations.map((c) => c.kind).sort()).toEqual([
      'criterion_value',
      'enrichment',
      'entity',
      'match',
      'record',
      'shortlist',
    ]);
    expect(evidence!.citations.every((c) => !c.dangling)).toBe(true);
  });

  it('names the row rather than its id', async () => {
    const db = await getTestDb();
    const evidence = await loadSentenceEvidence(db, { programId: PROGRAM, sentenceId: SENTENCE });
    const byKind = new Map(evidence!.citations.map((c) => [c.kind, c]));

    expect(byKind.get('entity')).toMatchObject({
      title: 'ROBERT BOSCH GMBH',
      detail: 'company · DEU',
    });
    expect(byKind.get('record')?.title).toBe('German commercial register');
    // `anchor_line` is the criterion's own account of how the number was
    // reached, stored beside it and never recomputed at render.
    expect(byKind.get('criterion_value')?.detail).toContain('starts at 100');
    expect(byKind.get('match')?.detail).toBe('accepted, settled by rules');
    expect(byKind.get('shortlist')?.title).toBe('BAT shortlist');
  });

  /**
   * A record id is a three-part path, so its href has to survive being one —
   * the record route takes a catch-all segment for exactly this reason, and
   * the braces stay percent-encoded because they are part of the id's own name.
   */
  it('builds a record href that the catch-all route can take back apart', async () => {
    const db = await getTestDb();
    const evidence = await loadSentenceEvidence(db, { programId: PROGRAM, sentenceId: SENTENCE });
    const record = evidence!.citations.find((c) => c.kind === 'record')!;

    expect(record.href).toBe(
      `/program/${PROGRAM}/record/src-hash/%7B93635462-94C0%7D/1672531200000`,
    );
    // What the route does with it: take the segments and rejoin, because the
    // id IS a path.
    const segments = record.href!.split('/').slice(4);
    expect(segments.map(decodeURIComponent).join('/')).toBe(RECORD);
  });

  it('carries the trail back to what published the sentence', async () => {
    const db = await getTestDb();
    const evidence = await loadSentenceEvidence(db, { programId: PROGRAM, sentenceId: SENTENCE });
    expect(evidence!.owner).toEqual({
      kind: 'assessment',
      supplierId: SUPPLIER,
      supplierName: 'Fixture Supplier',
      versionN: 1,
    });
  });

  /**
   * The Programme in the URL is a boundary, not decoration. Without this a
   * hand-edited URL would render another Programme's evidence under this
   * Programme's breadcrumb, which is worse than a 404 because it looks right.
   */
  it('refuses a sentence belonging to another programme', async () => {
    const db = await getTestDb();
    expect(await loadSentenceEvidence(db, { programId: PROGRAM, sentenceId: OTHER_SENTENCE })).toBeNull();
    // And it is genuinely reachable from its own.
    expect(
      await loadSentenceEvidence(db, { programId: OTHER_PROGRAM, sentenceId: OTHER_SENTENCE }),
    ).not.toBeNull();
  });

  it('returns nothing for a sentence that does not exist', async () => {
    const db = await getTestDb();
    const missing = await loadSentenceEvidence(db, {
      programId: PROGRAM,
      sentenceId: '00000000-0000-0000-0000-000000000000',
    });
    expect(missing).toBeNull();
  });
});

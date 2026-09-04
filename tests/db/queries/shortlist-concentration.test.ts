import { afterAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import * as t from '@/db/schema';
import { loadShortlist } from '@/db/queries/shortlist';
import { getTestDb, testDatabaseIsUp } from '../../support/test-db';
import { resetDerived } from '../../support/reset';
import { seededProgram } from '../../support/seeded-program';

/**
 * `loadShortlist`'s `concentrationWith` wiring (network spec §7) — proves the
 * Category page's free derivation reaches the Shortlist row, not just
 * `findConcentrations` in isolation (`tests/db/queries/family-paths.test.ts`
 * covers the query itself).
 *
 * Two bespoke Suppliers, on the seeded Program's real "HAR" Category
 * (`buildAssessableSupplier`'s own pattern would run the whole resolve/enrich
 * pipeline per Supplier, which this does not need — only a settled accepted
 * Match, one `criterion_value` row so each lands in `ranked` rather than
 * `excluded`, and the `graph_path` rows the join is over).
 */
const ROSTER_A = 'Concentration Test Supplier A';
const ROSTER_B = 'Concentration Test Supplier B';
const ROSTER_C = 'Concentration Test Supplier C';
const ENTITY_A = 'test-shortlist-concentration-entity-a';
const ENTITY_B = 'test-shortlist-concentration-entity-b';
const ENTITY_C = 'test-shortlist-concentration-entity-c';
const SHARED_PARENT = 'test-shortlist-concentration-shared-parent';

/** Module-scope top-level await, matching `discover-relations.test.ts`'s own convention — `testDatabaseIsUp()` is checked once, not re-derived per `it`. */
const up = await testDatabaseIsUp();

describe("loadShortlist's Concentration column", () => {
  afterAll(async () => {
    if (!up) return;
    const db = await getTestDb();
    const programId = (await seededProgram(db)).id;
    // All three — this used to delete only ROSTER_A, leaving B and C on the
    // real seeded "HAR" Category for every test file that ran afterward in
    // the same process. `recommend-replay.test.ts` builds its prompt from
    // exactly that Category's bidders, so the leak made its recorded fixture
    // replay-miss nondeterministically, depending on file execution order.
    await db
      .delete(t.supplier)
      .where(and(inArray(t.supplier.rosterName, [ROSTER_A, ROSTER_B, ROSTER_C]), eq(t.supplier.programId, programId)));
  });

  async function seedFixture() {
    const db = await getTestDb();
    await resetDerived(db);
    const program = await seededProgram(db);
    const category = await db.query.category.findFirst({ where: eq(t.category.code, 'HAR') });
    if (!category) throw new Error('no seeded Category "HAR"');

    await db.insert(t.entity).values([
      { id: ENTITY_A, label: 'Concentration Entity A', country: 'DEU' },
      { id: ENTITY_B, label: 'Concentration Entity B', country: 'FRA' },
      { id: ENTITY_C, label: 'Concentration Entity C', country: 'ITA' },
      { id: SHARED_PARENT, label: 'Concentration Shared Parent', country: 'DEU' },
      { id: 'test-shortlist-concentration-c-only', label: 'Only C reaches this' },
    ]);

    await db
      .delete(t.supplier)
      .where(and(eq(t.supplier.rosterName, ROSTER_A), eq(t.supplier.programId, program.id)));
    await db
      .delete(t.supplier)
      .where(and(eq(t.supplier.rosterName, ROSTER_B), eq(t.supplier.programId, program.id)));
    await db
      .delete(t.supplier)
      .where(and(eq(t.supplier.rosterName, ROSTER_C), eq(t.supplier.programId, program.id)));

    const [supplierA, supplierB, supplierC] = await db
      .insert(t.supplier)
      .values([
        { programId: program.id, origin: 'imported', rosterIndex: 9101, rosterName: ROSTER_A },
        { programId: program.id, origin: 'imported', rosterIndex: 9102, rosterName: ROSTER_B },
        { programId: program.id, origin: 'imported', rosterIndex: 9103, rosterName: ROSTER_C },
      ])
      .returning({ id: t.supplier.id });

    await db.insert(t.supplierCategory).values([
      { supplierId: supplierA!.id, categoryId: category.id },
      { supplierId: supplierB!.id, categoryId: category.id },
      { supplierId: supplierC!.id, categoryId: category.id },
    ]);

    await db.insert(t.match).values([
      { supplierId: supplierA!.id, status: 'accepted', entityId: ENTITY_A, settledBy: 'rules' },
      { supplierId: supplierB!.id, status: 'accepted', entityId: ENTITY_B, settledBy: 'rules' },
      { supplierId: supplierC!.id, status: 'accepted', entityId: ENTITY_C, settledBy: 'rules' },
    ]);

    // One Criterion value per Supplier, so each row has a Score and lands in
    // `ranked` rather than `excluded` (`buildShortlist`, `src/domain/score.ts`
    // — a Supplier with zero computed Criteria scores `null` regardless of
    // `matchAccepted`, which is a fact about scoring, not about Concentration,
    // and irrelevant to what this test proves).
    await db.insert(t.criterionValue).values([
      {
        supplierId: supplierA!.id,
        programId: program.id,
        categoryId: null,
        criterionKey: 'compliance_risk',
        value: 80,
        rawInputs: {},
        anchorLine: 'test anchor',
      },
      {
        supplierId: supplierB!.id,
        programId: program.id,
        categoryId: null,
        criterionKey: 'compliance_risk',
        value: 80,
        rawInputs: {},
        anchorLine: 'test anchor',
      },
      {
        supplierId: supplierC!.id,
        programId: program.id,
        categoryId: null,
        criterionKey: 'compliance_risk',
        value: 80,
        rawInputs: {},
        anchorLine: 'test anchor',
      },
    ]);

    const [upstreamResponse] = await db
      .insert(t.upstreamResponse)
      .values({
        source: 'sayari',
        endpoint: 'traversal.ownership',
        paramsHash: 'test-hash-shortlist-concentration',
        params: {},
        body: {},
        bodyHash: 'test-body-hash-shortlist-concentration',
        via: 'sdk',
      })
      .returning({ id: t.upstreamResponse.id });
    const [enrichment] = await db
      .insert(t.enrichment)
      .values({
        source: 'sayari_ownership_family',
        subjectKind: 'entity',
        subjectKey: ENTITY_A,
        requestParams: {},
        upstreamResponseId: upstreamResponse!.id,
      })
      .returning({ id: t.enrichment.id });

    // A and B's Networks both reach the same shared parent — B's own root is
    // NOT the shared entity, so this is the "two Suppliers under one parent"
    // shape (network spec §7), not "one owns the other".
    await db.insert(t.graphPath).values([
      {
        rootEntityId: ENTITY_A,
        terminalEntityId: SHARED_PARENT,
        kind: 'family',
        direction: 'down',
        hopDepth: 1,
        enrichmentId: enrichment!.id,
      },
      {
        rootEntityId: ENTITY_B,
        terminalEntityId: SHARED_PARENT,
        kind: 'family',
        direction: 'down',
        hopDepth: 1,
        enrichmentId: enrichment!.id,
      },
      // C's own family reaches nowhere A or B does — the negative case.
      {
        rootEntityId: ENTITY_C,
        terminalEntityId: 'test-shortlist-concentration-c-only',
        kind: 'family',
        direction: 'down',
        hopDepth: 1,
        enrichmentId: enrichment!.id,
      },
    ]);

    return { db, programId: program.id, categoryId: category.id, supplierA, supplierB, supplierC };
  }

  it('carries concentrationWith on both joined rows, symmetrically, and empty on the unjoined one', async () => {
    if (!up) return;
    const { db, programId, categoryId, supplierA, supplierB, supplierC } = await seedFixture();

    const shortlist = await loadShortlist(db, { programId, categoryId });
    const byId = new Map(shortlist.ranked.map((r) => [r.supplierId, r]));

    const rowA = byId.get(supplierA!.id);
    const rowB = byId.get(supplierB!.id);
    const rowC = byId.get(supplierC!.id);
    expect(rowA, 'Supplier A should be ranked, not excluded').toBeDefined();
    expect(rowB, 'Supplier B should be ranked, not excluded').toBeDefined();
    expect(rowC, 'Supplier C should be ranked, not excluded').toBeDefined();

    // A names B, with what joins them.
    expect(rowA!.concentrationWith).toEqual([
      {
        supplierId: supplierB!.id,
        displayName: expect.any(String),
        terminalEntityId: SHARED_PARENT,
        terminalLabel: 'Concentration Shared Parent',
      },
    ]);
    // And symmetrically, B names A back — computed once, not per row, but
    // both sides of the pair see it.
    expect(rowB!.concentrationWith).toEqual([
      {
        supplierId: supplierA!.id,
        displayName: expect.any(String),
        terminalEntityId: SHARED_PARENT,
        terminalLabel: 'Concentration Shared Parent',
      },
    ]);

    // C shares nothing with anyone — the honest empty state, not an absent
    // field.
    expect(rowC!.concentrationWith).toEqual([]);
  });
});

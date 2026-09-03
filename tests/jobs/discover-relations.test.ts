import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as t from '@/db/schema';
import { loadFamilyOwners, recordDiscoverTotal, recordLead } from '@/jobs/discover';
import { decideLeadRelation } from '@/domain/discover-leads';
import { getTestDb, testDatabaseIsUp, testSql } from '../support/test-db';
import { resetDerived } from '../support/reset';
import { buildAssessableSupplier } from '../support/pipeline';

/**
 * **A Lead is verified against THIS Program's ownership graph, and the badge
 * names the Supplier** (SPEC §11.2).
 *
 * Discover built its family map with `select().from(family_member)` — no
 * `WHERE` at all — so a Lead could be marked *related by ownership · verified*
 * because some **other** Sourcing Program's Supplier owned it, on a roster
 * this Program's user has never seen. And the map kept only the root entity
 * id, so the badge could not say whose family it was: `relatedSupplierId` was
 * written into every row as a literal `null`, which also meant the *possibly
 * related · name match, unverified* badge had no branch to render from —
 * `nameFlag` was computed one line above the insert and thrown away with
 * `void nameFlag`.
 *
 * `discoverLeads` end to end runs a classifier per row and cannot replay
 * offline, so the two halves are tested where they live: the decision purely
 * (`tests/domain/discover.test.ts`), and the query and the write here, against
 * the database that was answering the wrong question.
 */

const ROSTER_NAME = 'Yazaki';
/** Fixed, so a failure names the row it failed on — as in `constraints.test.ts`. */
const OTHER_PROGRAM = '9e9e9e9e-9999-4999-8999-999999999999';

const up = await testDatabaseIsUp();

afterAll(async () => {
  if (!up) return;
  await testSql()`DELETE FROM program WHERE id = ${OTHER_PROGRAM}`;
});

describe('the Corporate family map Discover verifies against', () => {
  it("holds only this Program's Family members, and names the Supplier", async () => {
    if (!up) return;
    const db = await getTestDb();

    await resetDerived(db);
    await testSql()`DELETE FROM program WHERE id = ${OTHER_PROGRAM}`;
    const built = await buildAssessableSupplier(db, ROSTER_NAME);

    const owners = await loadFamilyOwners(db, built.programId);
    expect(
      owners.size,
      'the enrich Job should have written a Corporate family, or there is nothing to scope',
    ).toBeGreaterThan(0);
    expect([...new Set(owners.values())]).toEqual([built.supplierId]);

    /**
     * A second Program, with its own Supplier, its own accepted Match and its
     * own Family member — the situation the missing `WHERE` could not tell
     * apart from this Program's. The member is an entity this Program's family
     * does not contain, so a leak shows up as an extra key rather than as a
     * changed value.
     */
    const outsider = [...owners.keys()][0]!;
    const entities = await db.select({ id: t.entity.id }).from(t.entity);
    const memberElsewhere = entities.map((row) => row.id).find((id) => !owners.has(id))!;
    expect(memberElsewhere, 'the fixture should hold an entity outside the family').toBeTruthy();

    const sql = testSql();
    await sql`INSERT INTO program (id, name, importing_country, vehicle_class, sourcing_horizon)
              VALUES (${OTHER_PROGRAM}, 'Another program', 'USA', 'BEV', 'FY2028')`;
    const [otherSupplier] = await db
      .insert(t.supplier)
      .values({
        programId: OTHER_PROGRAM,
        origin: 'imported',
        rosterIndex: 1,
        rosterName: 'Somebody else',
      })
      .returning({ id: t.supplier.id });
    await db.insert(t.match).values({
      supplierId: otherSupplier!.id,
      status: 'accepted',
      entityId: outsider,
      settledBy: 'rules',
    });
    const [existing] = await db
      .select({ id: t.graphPath.enrichmentId })
      .from(t.graphPath)
      .where(eq(t.graphPath.kind, 'family'))
      .limit(1);
    await db.insert(t.graphPath).values({
      enrichmentId: existing!.id,
      rootEntityId: outsider,
      terminalEntityId: memberElsewhere,
      kind: 'family',
      direction: 'down',
      hopDepth: 1,
    });

    const after = await loadFamilyOwners(db, built.programId);
    expect(after.has(memberElsewhere), "another Program's family row must not reach here").toBe(
      false,
    );
    expect([...after.keys()].sort()).toEqual([...owners.keys()].sort());

    // And the other Program's own Discover run does see it, which is what
    // makes this a scope rather than a filter that drops rows.
    const theirs = await loadFamilyOwners(db, OTHER_PROGRAM);
    expect(theirs.get(memberElsewhere)).toBe(otherSupplier!.id);
  });
});

describe('the Lead row Discover writes', () => {
  it('stores the name-token flag, the related Supplier and why nothing was classified', async () => {
    if (!up) return;
    const db = await getTestDb();

    await resetDerived(db);
    const built = await buildAssessableSupplier(db, ROSTER_NAME);
    const category = await db.query.category.findFirst({
      where: eq(t.category.programId, built.programId),
    });
    const owners = await loadFamilyOwners(db, built.programId);
    const member = [...owners.keys()][0]!;
    const memberEntity = await db.query.entity.findFirst({ where: eq(t.entity.id, member) });

    // A candidate that is already in the Supplier's Corporate family: the
    // verified case, which must name the Supplier it is verified against.
    const relation = decideLeadRelation(
      { entityId: member, label: memberEntity!.label },
      {
        familyOwners: owners,
        roster: [{ supplierId: built.supplierId, rosterName: ROSTER_NAME }],
      },
    );

    await recordLead(db, {
      programId: built.programId,
      categoryId: category!.id,
      candidate: {
        entity: { id: member, label: memberEntity!.label } as never,
        shipments: 1_047,
        latestShipmentDate: null,
        // Deliberately not the query's own '854430' — a Lead's HS footprint
        // is the ROW's (ticket 01 item C), and this is what pins that down.
        hsCodes: ['854431'],
      },
      query: { hsCodes: ['854430'], arrivalCountries: ['USA', 'MEX'] },
      classification: {
        classification: null,
        reasoning: null,
        notClassifiedReason: 'the classifier loop stopped: tool-call cap reached',
      },
      relation,
      jobId: undefined,
    });

    /**
     * And the other branch on the same run: a company the ownership graph does
     * **not** hold, whose name shares a token with the roster. It is a
     * question rather than a fact, so it is stored unverified — with the
     * Supplier it is a question about, which is the half `void nameFlag` threw
     * away.
     */
    const guessId = 'test-entity-yazaki-morocco';
    await db
      .insert(t.entity)
      .values({ id: guessId, label: 'YAZAKI MOROCCO SARL' })
      .onConflictDoNothing();
    const guess = decideLeadRelation(
      { entityId: guessId, label: 'YAZAKI MOROCCO SARL' },
      {
        familyOwners: owners,
        roster: [{ supplierId: built.supplierId, rosterName: ROSTER_NAME }],
      },
    );
    await recordLead(db, {
      programId: built.programId,
      categoryId: category!.id,
      candidate: {
        entity: { id: guessId, label: 'YAZAKI MOROCCO SARL' } as never,
        shipments: 12,
        latestShipmentDate: '2026-04-02',
        hsCodes: ['854430'],
      },
      query: { hsCodes: ['854430'], arrivalCountries: ['USA', 'MEX'] },
      classification: {
        classification: 'manufacturer',
        reasoning: 'assembles harnesses',
        notClassifiedReason: null,
      },
      relation: guess,
      jobId: undefined,
    });

    const flagged = await db.query.lead.findFirst({ where: eq(t.lead.entityId, guessId) });
    expect(flagged?.relatedSupplierId, 'the name-token flag is stored, not voided').toBe(
      built.supplierId,
    );
    expect(flagged?.relationVerified, 'a name token is a question, never a verification').toBe(
      false,
    );
    expect(flagged?.classification).toBe('manufacturer');
    expect(flagged?.notClassifiedReason).toBeNull();

    const lead = await db.query.lead.findFirst({ where: eq(t.lead.entityId, member) });
    expect(lead?.relatedSupplierId, 'the related Supplier is named on the row').toBe(
      built.supplierId,
    );
    expect(lead?.relationVerified).toBe(true);
    /**
     * And the failure is recorded as a failure. `unclear` is a real answer a
     * person can act on; a loop that hit its cap made no judgement at all, and
     * writing the model's word for it would be putting words in its mouth.
     */
    expect(lead?.classification).toBeNull();
    expect(lead?.notClassifiedReason).toBe('the classifier loop stopped: tool-call cap reached');

    /**
     * **A Lead's HS footprint is the row's, never the query's** (ticket 01
     * item C, `hsCodesOf`). The row's own `hsCodes` differs from the query's
     * here on purpose, and it is the row's that lands on the Lead.
     */
    expect(lead?.topHsCodes).toEqual(['854431']);
  });
});

describe('recordLead self-heals its own row-evidence columns on conflict (A6)', () => {
  it('rewrites top_hs_codes and shipment_count on a re-run, and leaves the rest as the first run wrote it', async () => {
    if (!up) return;
    const db = await getTestDb();

    await resetDerived(db);
    const built = await buildAssessableSupplier(db, ROSTER_NAME);
    const category = await db.query.category.findFirst({
      where: eq(t.category.programId, built.programId),
    });
    const owners = await loadFamilyOwners(db, built.programId);
    const member = [...owners.keys()][0]!;
    const memberEntity = await db.query.entity.findFirst({ where: eq(t.entity.id, member) });
    const relation = decideLeadRelation(
      { entityId: member, label: memberEntity!.label },
      {
        familyOwners: owners,
        roster: [{ supplierId: built.supplierId, rosterName: ROSTER_NAME }],
      },
    );

    await recordLead(db, {
      programId: built.programId,
      categoryId: category!.id,
      candidate: {
        entity: { id: member, label: memberEntity!.label } as never,
        shipments: 10,
        latestShipmentDate: '2020-01-01',
        hsCodes: ['111111'],
      },
      query: { hsCodes: ['854430'], arrivalCountries: ['USA', 'MEX'] },
      classification: {
        classification: 'manufacturer',
        reasoning: 'first run',
        notClassifiedReason: null,
      },
      relation,
      jobId: undefined,
    });

    // A second run: the row's own evidence moved (a different shipment
    // window), but the classifier was not asked again — that column must
    // stay exactly what the first run decided, not be voided by this run's
    // own null.
    await recordLead(db, {
      programId: built.programId,
      categoryId: category!.id,
      candidate: {
        entity: { id: member, label: memberEntity!.label } as never,
        shipments: 99,
        latestShipmentDate: '2020-01-01',
        hsCodes: ['222222'],
      },
      query: { hsCodes: ['854430'], arrivalCountries: ['USA', 'MEX'] },
      classification: {
        classification: null,
        reasoning: null,
        notClassifiedReason: 'the classifier loop stopped: tool-call cap reached',
      },
      relation,
      jobId: undefined,
    });

    const lead = await db.query.lead.findFirst({ where: eq(t.lead.entityId, member) });
    // Row-own evidence self-heals.
    expect(lead?.topHsCodes).toEqual(['222222']);
    expect(lead?.shipmentCount).toBe(99);
    // Everything else is untouched by the re-run.
    expect(lead?.classification).toBe('manufacturer');
    expect(lead?.classificationReasoning).toBe('first run');
  });
});

describe('recordDiscoverTotal overwrites the Category row, whole, per run (A3+C3)', () => {
  it('writes the count, the qualifier and when it ran, and a later run overwrites all three', async () => {
    if (!up) return;
    const db = await getTestDb();

    await resetDerived(db);
    const built = await buildAssessableSupplier(db, ROSTER_NAME);
    const category = await db.query.category.findFirst({
      where: eq(t.category.programId, built.programId),
    });

    await recordDiscoverTotal(db, { categoryId: category!.id, count: 25, qualifier: 'eq' });
    const first = await db.query.category.findFirst({ where: eq(t.category.id, category!.id) });
    expect(first?.discoverTotalCount).toBe(25);
    expect(first?.discoverTotalQualifier).toBe('eq');
    expect(first?.discoveredAt).toBeTruthy();

    // A later run disagrees — a `gte` floor this time, off a bigger query —
    // and the row carries the LATEST run's numbers, not a merge of the two.
    await recordDiscoverTotal(db, { categoryId: category!.id, count: 10_000, qualifier: 'gte' });
    const second = await db.query.category.findFirst({ where: eq(t.category.id, category!.id) });
    expect(second?.discoverTotalCount).toBe(10_000);
    expect(second?.discoverTotalQualifier).toBe('gte');
  });
});

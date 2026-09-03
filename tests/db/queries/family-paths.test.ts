import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as t from '@/db/schema';
import { getRegistry, type ToolContext } from '@/tools';
import { loadFamilyPaths, terminalEdgeOf } from '@/db/queries/family-paths';
import { loadSupplierPage } from '@/db/queries/supplier-page';
import { loadEntityPage } from '@/db/queries/entity-page';
import { loadFamilyOwners } from '@/jobs/discover';
import { getTestDb, testDatabaseIsUp } from '../../support/test-db';
import { resetDerived } from '../../support/reset';
import { seededProgram } from '../../support/seeded-program';

/**
 * `graph_path` (kind `family`) joined to `entity_relationship`, seeded
 * directly rather than through the enrich pipeline (ticket 02c's own brief:
 * the sibling write-side unit, 02b, has not landed in this worktree, so
 * `family-members.ts`/`enrich.ts` still write nothing here). This is the one
 * place the read side can be proven correct without depending on it —
 * everything downstream of `graph_path`/`entity_relationship` reads exactly
 * the same whichever side wrote the rows.
 *
 * The family built here has three members, on purpose:
 *
 * - `MEMBER_A`, one hop, one edge, a record behind it — the ordinary case.
 * - `MEMBER_B`, two hops, TWO edges (root → A, A → B) — proves the citation
 *   fix reads the LAST edge (the one nearest the member), not the first.
 * - `MEMBER_C`, `edge_ids: []` — the documented migration-0013 gap (a
 *   migrated `family_member` row with a real hop depth and no edges yet) —
 *   proves that case degrades to "no citable edge" rather than a crash or a
 *   fallback to `enrichmentId`.
 */
describe('graph_path (kind family), read side', () => {
  const ROOT = 'test-root-family-paths';
  const MEMBER_A = 'test-member-a-family-paths';
  const MEMBER_B = 'test-member-b-family-paths';
  const MEMBER_C = 'test-member-c-family-paths';
  const RECORD_A = 'source/rec-a/1700000000000';
  const RECORD_AB = 'source/rec-ab/1700000000000';

  async function seedFamily() {
    const db = await getTestDb();
    await resetDerived(db);
    const program = await seededProgram(db);

    const supplier = await db.query.supplier.findFirst({ where: eq(t.supplier.rosterName, 'Yazaki') });
    if (!supplier) throw new Error('no seeded supplier "Yazaki"');

    await db.insert(t.entity).values([
      { id: ROOT, label: 'Root Co', country: 'JPN' },
      {
        id: MEMBER_A,
        label: 'Member A',
        country: 'DEU',
        sanctioned: true,
        risk: { sanctioned: { level: 'high' } },
      },
      { id: MEMBER_B, label: 'Member B', country: 'ROU' },
      { id: MEMBER_C, label: 'Member C', country: 'CHN' },
    ]);

    await db.insert(t.match).values({
      supplierId: supplier.id,
      status: 'accepted',
      entityId: ROOT,
      settledBy: 'rules',
    });

    const [upstreamResponse] = await db
      .insert(t.upstreamResponse)
      .values({
        source: 'sayari',
        endpoint: 'traversal.ownership',
        paramsHash: 'test-hash',
        params: { entityId: ROOT },
        body: {},
        bodyHash: 'test-body-hash',
        via: 'sdk',
      })
      .returning({ id: t.upstreamResponse.id });

    const [enrichment] = await db
      .insert(t.enrichment)
      .values({
        source: 'sayari_ownership_family',
        subjectKind: 'entity',
        subjectKey: ROOT,
        requestParams: { entityId: ROOT },
        upstreamResponseId: upstreamResponse!.id,
      })
      .returning({ id: t.enrichment.id });

    await db.insert(t.record).values([{ id: RECORD_A }, { id: RECORD_AB }]);

    const [edgeRootA] = await db
      .insert(t.entityRelationship)
      .values({
        fromEntityId: ROOT,
        toEntityId: MEMBER_A,
        relationshipType: 'has_shareholder',
        sourceRecordId: RECORD_A,
        attributes: { shares: [{ percentage: 51 }] },
        startDate: '2018-01-01',
      })
      .returning({ id: t.entityRelationship.id });
    const [edgeAB] = await db
      .insert(t.entityRelationship)
      .values({
        fromEntityId: MEMBER_A,
        toEntityId: MEMBER_B,
        relationshipType: 'has_shareholder',
        sourceRecordId: RECORD_AB,
        attributes: { shares: [{ percentage: 70 }] },
        startDate: '2019-06-01',
      })
      .returning({ id: t.entityRelationship.id });

    // All three rows share ONE `enrichmentId` — one read, one envelope — so
    // `exploredCount`/`truncated` (both envelope-sourced, network spec §6)
    // are the same figure on every row here on purpose: a real automatic
    // read never writes two different envelope figures for one call.
    await db.insert(t.graphPath).values([
      {
        rootEntityId: ROOT,
        terminalEntityId: MEMBER_A,
        kind: 'family',
        direction: 'down',
        hopDepth: 1,
        edgeIds: [edgeRootA!.id],
        exploredCount: 3,
        enrichmentId: enrichment!.id,
        truncated: true,
      },
      {
        rootEntityId: ROOT,
        terminalEntityId: MEMBER_B,
        kind: 'family',
        direction: 'down',
        hopDepth: 2,
        edgeIds: [edgeRootA!.id, edgeAB!.id],
        exploredCount: 3,
        enrichmentId: enrichment!.id,
        truncated: true,
      },
      {
        // The migration-0013 gap: a real hop depth, no hydrated edges.
        rootEntityId: ROOT,
        terminalEntityId: MEMBER_C,
        kind: 'family',
        direction: 'down',
        hopDepth: 1,
        edgeIds: [],
        exploredCount: 3,
        enrichmentId: enrichment!.id,
        truncated: true,
      },
    ]);

    return { db, program, supplier, enrichmentId: enrichment!.id };
  }

  it('loadFamilyPaths hydrates each Path with its own ordered chain of entity_relationship edges', async () => {
    if (!(await testDatabaseIsUp())) return;
    const { db } = await seedFamily();

    const paths = await loadFamilyPaths(db, ROOT);
    expect(paths.map((p) => p.terminalEntityId).sort()).toEqual(
      [MEMBER_A, MEMBER_B, MEMBER_C].sort(),
    );

    const a = paths.find((p) => p.terminalEntityId === MEMBER_A)!;
    expect(a.edges.map((e) => e.sourceRecordId)).toEqual([RECORD_A]);
    expect(a.edges[0]!.sharePercentage).toBe(51);

    // Two hops, in root→terminal order — the LAST edge is the one nearest B.
    const b = paths.find((p) => p.terminalEntityId === MEMBER_B)!;
    expect(b.edges.map((e) => e.sourceRecordId)).toEqual([RECORD_A, RECORD_AB]);
    expect(terminalEdgeOf(b)?.sourceRecordId).toBe(RECORD_AB);

    const c = paths.find((p) => p.terminalEntityId === MEMBER_C)!;
    expect(c.edges).toEqual([]);
    expect(terminalEdgeOf(c)).toBeNull();
  });

  it('get_supplier_family cites each member to the record asserting ITS OWN edge, not to the enrichment', async () => {
    if (!(await testDatabaseIsUp())) return;
    const { db, supplier } = await seedFamily();

    const ctx: ToolContext = {
      db,
      upstream: undefined as never,
      meter: { addModelTokens: () => {} },
      runId: 'test-run',
      surface: 'job',
    };
    const result = await getRegistry().byName.get('get_supplier_family')!.handler(
      { supplierId: supplier.id },
      ctx,
    );
    if (!result.ok) throw new Error(result.objections.join('; '));
    // `{ data, widget }`, same as `citation-targets.test.ts`'s `call()`: the
    // model reads the `data` half.
    const family = (result.data as { data: unknown }).data as {
      explored: number;
      reachable: number | null;
      truncated: boolean;
      members: { entityId: string; recordId: string | null; enrichmentId: string }[];
    };

    // The row count, not a stored counter — `graph_path`'s unique
    // (root, terminal, kind) index is what makes that safe now.
    expect(family.explored).toBe(3);
    expect(family.reachable).toBe(3);
    // MEMBER_C's row is truncated; the envelope says so even though the
    // other two Paths are not.
    expect(family.truncated).toBe(true);

    const byId = new Map(family.members.map((m) => [m.entityId, m]));
    // The ticket 02 "Done when": cited to the record asserting its OWN edge.
    expect(byId.get(MEMBER_A)?.recordId).toBe(RECORD_A);
    // B's citation is the LAST hop (A → B), not the first (root → A) and not
    // the enrichment that found the whole walk.
    expect(byId.get(MEMBER_B)?.recordId).toBe(RECORD_AB);
    // C has no hydrated edge yet, and that is a stated gap, not a silent
    // fallback to the read that found it.
    expect(byId.get(MEMBER_C)?.recordId).toBeNull();
  });

  it("the Supplier page's coverage, exposure and chain rows agree with the tool", async () => {
    if (!(await testDatabaseIsUp())) return;
    const { db, program, supplier } = await seedFamily();

    const page = await loadSupplierPage(db, {
      programId: program.id,
      supplierId: supplier.id,
      query: {},
    });
    expect(page).toBeDefined();
    expect(page!.coverage).toEqual({ explored: 3, reachable: 3, partial: true });
    expect(page!.exposure.state).toBe('exposure_found');
    if (page!.exposure.state === 'exposure_found') {
      expect(page!.exposure.members.map((m) => m.entityId)).toContain(MEMBER_A);
    }

    const chainForB = page!.familyChain.find((p) => p.terminalEntityId === MEMBER_B)!;
    expect(chainForB.edges.map((e) => e.sourceRecordId)).toEqual([RECORD_A, RECORD_AB]);
    const chainForC = page!.familyChain.find((p) => p.terminalEntityId === MEMBER_C)!;
    expect(chainForC.edges).toEqual([]);
  });

  it("the Entity page's KnownAs family case reads the same graph_path rows", async () => {
    if (!(await testDatabaseIsUp())) return;
    const { db, program } = await seedFamily();

    const entityPage = await loadEntityPage(db, { programId: program.id, entityId: MEMBER_A });
    expect(entityPage).toBeDefined();
    const familyCase = entityPage!.knownAs.find((c) => c.kind === 'family');
    expect(familyCase).toBeDefined();
    if (familyCase?.kind === 'family') expect(familyCase.hopDepth).toBe(1);
  });

  it("Discover's family map scopes to this Program's accepted Profile", async () => {
    if (!(await testDatabaseIsUp())) return;
    const { db, program, supplier } = await seedFamily();

    const owners = await loadFamilyOwners(db, program.id);
    expect(owners.get(MEMBER_A)).toBe(supplier.id);
    expect(owners.get(MEMBER_B)).toBe(supplier.id);
  });
});

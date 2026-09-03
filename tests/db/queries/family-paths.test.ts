import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as t from '@/db/schema';
import { getRegistry, type ToolContext } from '@/tools';
import { loadFamilyPaths, loadNetworkExposurePaths, terminalEdgeOf } from '@/db/queries/family-paths';
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

  it("the Supplier page's coverage and chain rows agree with the tool", async () => {
    if (!(await testDatabaseIsUp())) return;
    const { db, program, supplier } = await seedFamily();

    const page = await loadSupplierPage(db, {
      programId: program.id,
      supplierId: supplier.id,
      query: {},
    });
    expect(page).toBeDefined();
    expect(page!.coverage).toEqual({ explored: 3, reachable: 3, partial: true });
    // No more standalone Family exposure badge on the page data (network spec
    // §5, ticket 03 unit 03b): MEMBER_A's own `sanctioned: true`/`risk` now
    // scores inside `networkExposure`, covered in `tests/domain/score.test.ts`
    // rather than here — this file stays the read-side proof for `graph_path`.

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

/**
 * `loadNetworkExposurePaths` — Network exposure's multi-hop input (network
 * spec §5, ticket 03 unit 03b): `family` and `watchlist` kinds together, each
 * hop classified ownership/control against trade.
 */
describe('loadNetworkExposurePaths — family + watchlist, hop classification', () => {
  const ROOT = 'test-root-network-exposure-paths';
  const FAMILY_MEMBER = 'test-network-family-member';
  const LISTED_VIA_OWNERSHIP = 'test-network-listed-ownership';
  const LISTED_VIA_TRADE = 'test-network-listed-trade';

  async function seedNetwork() {
    const db = await getTestDb();
    await resetDerived(db);

    await db.insert(t.entity).values([
      { id: ROOT, label: 'Root Co', country: 'JPN' },
      {
        id: FAMILY_MEMBER,
        label: 'Family Member',
        country: 'DEU',
        risk: { forced_labor_something_direct: { level: 'elevated' } },
      },
      {
        id: LISTED_VIA_OWNERSHIP,
        label: 'Listed Via Ownership',
        country: 'RUS',
        sanctioned: true,
        risk: { sanctioned: { level: 'high' } },
      },
      {
        id: LISTED_VIA_TRADE,
        label: 'Listed Via Trade',
        country: 'CHN',
        sanctioned: true,
        risk: { sanctioned: { level: 'high' } },
      },
    ]);

    const [upstreamResponse] = await db
      .insert(t.upstreamResponse)
      .values({
        source: 'sayari',
        endpoint: 'traversal.watchlist',
        paramsHash: 'test-hash-network-paths',
        params: { entityId: ROOT },
        body: {},
        bodyHash: 'test-body-hash-network-paths',
        via: 'sdk',
      })
      .returning({ id: t.upstreamResponse.id });

    const [enrichmentFamily] = await db
      .insert(t.enrichment)
      .values({
        source: 'sayari_ownership_family',
        subjectKind: 'entity',
        subjectKey: ROOT,
        requestParams: { entityId: ROOT },
        upstreamResponseId: upstreamResponse!.id,
      })
      .returning({ id: t.enrichment.id });
    const [enrichmentWatchlist] = await db
      .insert(t.enrichment)
      .values({
        source: 'sayari_watchlist',
        subjectKind: 'entity',
        subjectKey: ROOT,
        requestParams: { entityId: ROOT },
        upstreamResponseId: upstreamResponse!.id,
      })
      .returning({ id: t.enrichment.id });

    await db.insert(t.record).values([
      { id: 'source/rec-network-fam/1700000000000' },
      { id: 'source/rec-network-own/1700000000000' },
      { id: 'source/rec-network-trade/1700000000000' },
    ]);

    // Root → Family Member, `has_shareholder` — ownership, upward-classified
    // in `src/domain/relationships.ts`, but `isOwnership` does not care about
    // direction, only whether the type is an ownership/control one.
    const [edgeOwnershipHop] = await db
      .insert(t.entityRelationship)
      .values({
        fromEntityId: ROOT,
        toEntityId: FAMILY_MEMBER,
        relationshipType: 'has_shareholder',
        sourceRecordId: 'source/rec-network-fam/1700000000000',
      })
      .returning({ id: t.entityRelationship.id });
    // Root → Listed Via Ownership, one hop, pure ownership.
    const [edgeListedOwnership] = await db
      .insert(t.entityRelationship)
      .values({
        fromEntityId: ROOT,
        toEntityId: LISTED_VIA_OWNERSHIP,
        relationshipType: 'has_shareholder',
        sourceRecordId: 'source/rec-network-own/1700000000000',
      })
      .returning({ id: t.entityRelationship.id });
    // Family Member → Listed Via Trade, `ships_to` — a trade hop, so the
    // Path to Listed Via Trade is NOT ownership/control all the way even
    // though its first hop (reused from the family Path above) was.
    const [edgeTradeHop] = await db
      .insert(t.entityRelationship)
      .values({
        fromEntityId: FAMILY_MEMBER,
        toEntityId: LISTED_VIA_TRADE,
        relationshipType: 'ships_to',
        sourceRecordId: 'source/rec-network-trade/1700000000000',
      })
      .returning({ id: t.entityRelationship.id });

    await db.insert(t.graphPath).values([
      {
        rootEntityId: ROOT,
        terminalEntityId: FAMILY_MEMBER,
        kind: 'family',
        direction: 'down',
        hopDepth: 1,
        edgeIds: [edgeOwnershipHop!.id],
        exploredCount: 5,
        truncated: false,
        enrichmentId: enrichmentFamily!.id,
      },
      {
        rootEntityId: ROOT,
        terminalEntityId: LISTED_VIA_OWNERSHIP,
        kind: 'watchlist',
        direction: 'either',
        hopDepth: 1,
        edgeIds: [edgeListedOwnership!.id],
        exploredCount: 40,
        truncated: true,
        enrichmentId: enrichmentWatchlist!.id,
      },
      {
        rootEntityId: ROOT,
        terminalEntityId: LISTED_VIA_TRADE,
        kind: 'watchlist',
        direction: 'either',
        hopDepth: 2,
        edgeIds: [edgeOwnershipHop!.id, edgeTradeHop!.id],
        exploredCount: 40,
        truncated: true,
        enrichmentId: enrichmentWatchlist!.id,
      },
    ]);

    return { db };
  }

  it('classifies each Path viaOwnership by its OWN edges, not by kind alone', async () => {
    if (!(await testDatabaseIsUp())) return;
    const { db } = await seedNetwork();

    const { paths, coverage } = await loadNetworkExposurePaths(db, ROOT);
    expect(paths.map((p) => p.terminalEntityId).sort()).toEqual(
      [FAMILY_MEMBER, LISTED_VIA_OWNERSHIP, LISTED_VIA_TRADE].sort(),
    );

    const family = paths.find((p) => p.terminalEntityId === FAMILY_MEMBER)!;
    expect(family.kind).toBe('family');
    expect(family.viaOwnership).toBe(true);

    // Pure ownership, one hop: deducts in `networkExposure`.
    const listedOwnership = paths.find((p) => p.terminalEntityId === LISTED_VIA_OWNERSHIP)!;
    expect(listedOwnership.kind).toBe('watchlist');
    expect(listedOwnership.viaOwnership).toBe(true);
    expect(listedOwnership.sanctioned).toBe(true);

    // A trade hop breaks the chain even though the FIRST hop was ownership —
    // shown, never deducted (network spec §5).
    const listedTrade = paths.find((p) => p.terminalEntityId === LISTED_VIA_TRADE)!;
    expect(listedTrade.kind).toBe('watchlist');
    expect(listedTrade.viaOwnership).toBe(false);
    expect(listedTrade.hopDepth).toBe(2);

    // Coverage is per kind, read off that kind's own rows — never conflated.
    expect(coverage.family).toEqual({ exploredCount: 5, truncated: false });
    expect(coverage.watchlist).toEqual({ exploredCount: 40, truncated: true });
  });

  it("loadFamilyPaths, unchanged, still sees only this root's kind='family' rows", async () => {
    if (!(await testDatabaseIsUp())) return;
    const { db } = await seedNetwork();

    const familyOnly = await loadFamilyPaths(db, ROOT);
    expect(familyOnly.map((p) => p.terminalEntityId)).toEqual([FAMILY_MEMBER]);
  });
});

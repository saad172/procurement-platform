import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as t from '@/db/schema';
import { getRegistry, type ToolContext } from '@/tools';
import {
  findConcentrations,
  loadFamilyPaths,
  loadNetworkExposurePaths,
  terminalEdgeOf,
} from '@/db/queries/family-paths';
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

    const supplier = await db.query.supplier.findFirst({
      where: eq(t.supplier.rosterName, 'Yazaki'),
    });
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

  it('get_supplier_network cites each family-group member to the record asserting ITS OWN edge, not to the enrichment', async () => {
    if (!(await testDatabaseIsUp())) return;
    const { db, supplier } = await seedFamily();

    const ctx: ToolContext = {
      db,
      upstream: undefined as never,
      meter: { addModelTokens: () => {} },
      runId: 'test-run',
      surface: 'job',
    };
    const result = await getRegistry()
      .byName.get('get_supplier_network')!
      .handler({ supplierId: supplier.id }, ctx);
    if (!result.ok) throw new Error(result.objections.join('; '));
    // `{ data, widget }`, same as `citation-targets.test.ts`'s `call()`: the
    // model reads the `data` half.
    const network = (result.data as { data: unknown }).data as {
      groups: {
        family: {
          explored: number;
          reachable: number | null;
          truncated: boolean;
          members: { entityId: string; recordId: string | null; enrichmentId: string }[];
        };
        watchlist: { explored: number; members: unknown[] };
      };
    };
    const family = network.groups.family;

    // The row count, not a stored counter — `graph_path`'s unique
    // (root, terminal, kind) index is what makes that safe now.
    expect(family.explored).toBe(3);
    expect(family.reachable).toBe(3);
    // MEMBER_C's row is truncated; the envelope says so even though the
    // other two Paths are not.
    expect(family.truncated).toBe(true);

    // No watchlist Paths were seeded — an empty group is a real, reported
    // state (network spec §9), not a failure.
    expect(network.groups.watchlist.explored).toBe(0);
    expect(network.groups.watchlist.members).toEqual([]);

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

    await db
      .insert(t.record)
      .values([
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

/**
 * The bug this ticket fixes: `possibly_same_as` hops routed through the
 * MIDDLE of an otherwise-current-ownership chain used to fail `viaOwnership`
 * because `isOwnership('possibly_same_as')` is (correctly) `false`, and the
 * old computation required EVERY hop, psa included, to individually pass
 * `isOwnership`. A live Yazaki Path had exactly this shape —
 * `has_subsidiary → possibly_same_as → possibly_same_as → shareholder_of`,
 * all four hops current — and never deducted.
 */
describe('loadNetworkExposurePaths — possibly_same_as hops are skipped, not required to be ownership', () => {
  const ROOT = 'test-root-psa-hops';
  const HOP_1 = 'test-psa-hop-1';
  const HOP_2 = 'test-psa-hop-2';
  const OWNED_THROUGH_PSA = 'test-owned-through-psa';
  const PSA_ONLY = 'test-psa-only-no-real-edge';
  const TRADE_AFTER_PSA = 'test-trade-after-psa';

  async function seedPsaRoutedFamily() {
    const db = await getTestDb();
    await resetDerived(db);

    await db.insert(t.entity).values([
      { id: ROOT, label: 'Root Co', country: 'JPN' },
      { id: HOP_1, label: 'Root Co (record 2)', country: 'JPN' },
      { id: HOP_2, label: 'Root Co (record 3)', country: 'JPN' },
      { id: OWNED_THROUGH_PSA, label: 'Owned Through Psa', country: 'ROU' },
      { id: PSA_ONLY, label: 'Psa Only, No Real Edge', country: 'MAR' },
      { id: TRADE_AFTER_PSA, label: 'Trade After Psa', country: 'CHN' },
    ]);

    const [upstreamResponse] = await db
      .insert(t.upstreamResponse)
      .values({
        source: 'sayari',
        endpoint: 'traversal.ownership',
        paramsHash: 'test-hash-psa-hops',
        params: { entityId: ROOT },
        body: {},
        bodyHash: 'test-body-hash-psa-hops',
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

    // Root --has_subsidiary--> Hop 1 --possibly_same_as--> Hop 2
    //      --possibly_same_as--> Owned Through Psa — the exact live Yazaki
    // shape: two psa hops sandwiched between two real, current ownership
    // edges. `possibly_same_as` never appears in `RELATIONSHIP_TYPES`
    // (`isOwnership('possibly_same_as')` is `false`), so this chain proves
    // `viaOwnership` skips the psa hops rather than requiring them to pass.
    const [edgeSubsidiary] = await db
      .insert(t.entityRelationship)
      .values({
        fromEntityId: ROOT,
        toEntityId: HOP_1,
        relationshipType: 'has_subsidiary',
        sourceRecordId: 'source/rec-psa-1/1700000000000',
      })
      .returning({ id: t.entityRelationship.id });
    const [edgePsaA] = await db
      .insert(t.entityRelationship)
      .values({
        fromEntityId: HOP_1,
        toEntityId: HOP_2,
        relationshipType: 'possibly_same_as',
        sourceRecordId: 'source/rec-psa-2/1700000000000',
      })
      .returning({ id: t.entityRelationship.id });
    const [edgePsaB] = await db
      .insert(t.entityRelationship)
      .values({
        fromEntityId: HOP_2,
        toEntityId: OWNED_THROUGH_PSA,
        relationshipType: 'possibly_same_as',
        sourceRecordId: 'source/rec-psa-3/1700000000000',
      })
      .returning({ id: t.entityRelationship.id });

    // Root --possibly_same_as--> Psa Only — zero real relationship edges, the
    // edge case worth its own row: record-linking to a twin of the SAME
    // company asserts nothing about ownership of anything else, so this must
    // stay `viaOwnership: false` rather than vacuously `true` for having no
    // hop that fails `isOwnership`.
    const [edgePsaOnly] = await db
      .insert(t.entityRelationship)
      .values({
        fromEntityId: ROOT,
        toEntityId: PSA_ONLY,
        relationshipType: 'possibly_same_as',
        sourceRecordId: 'source/rec-psa-only/1700000000000',
      })
      .returning({ id: t.entityRelationship.id });

    // Root --possibly_same_as--> Hop 1 --ships_to--> Trade After Psa — proves
    // skipping the psa hop does not turn every psa-adjacent Path into
    // `viaOwnership: true`: the one non-psa hop here is trade, not
    // ownership, so this must still be `false`.
    const [edgeTradeAfterPsa] = await db
      .insert(t.entityRelationship)
      .values({
        fromEntityId: HOP_1,
        toEntityId: TRADE_AFTER_PSA,
        relationshipType: 'ships_to',
        sourceRecordId: 'source/rec-psa-trade/1700000000000',
      })
      .returning({ id: t.entityRelationship.id });

    await db.insert(t.graphPath).values([
      {
        rootEntityId: ROOT,
        terminalEntityId: OWNED_THROUGH_PSA,
        kind: 'family',
        direction: 'down',
        hopDepth: 2,
        edgeIds: [edgeSubsidiary!.id, edgePsaA!.id, edgePsaB!.id],
        exploredCount: 10,
        truncated: false,
        enrichmentId: enrichmentFamily!.id,
      },
      {
        rootEntityId: ROOT,
        terminalEntityId: PSA_ONLY,
        kind: 'family',
        direction: 'down',
        hopDepth: 1,
        edgeIds: [edgePsaOnly!.id],
        exploredCount: 10,
        truncated: false,
        enrichmentId: enrichmentFamily!.id,
      },
      {
        rootEntityId: ROOT,
        terminalEntityId: TRADE_AFTER_PSA,
        kind: 'family',
        direction: 'down',
        hopDepth: 1,
        edgeIds: [edgePsaOnly!.id, edgeTradeAfterPsa!.id],
        exploredCount: 10,
        truncated: false,
        enrichmentId: enrichmentFamily!.id,
      },
    ]);

    return { db };
  }

  it('a psa hop sandwiched between two current ownership edges still deducts (the live Yazaki bug)', async () => {
    if (!(await testDatabaseIsUp())) return;
    const { db } = await seedPsaRoutedFamily();

    const { paths } = await loadNetworkExposurePaths(db, ROOT);
    const owned = paths.find((p) => p.terminalEntityId === OWNED_THROUGH_PSA)!;
    expect(owned.edges.map((e) => e.relationshipType)).toEqual([
      'has_subsidiary',
      'possibly_same_as',
      'possibly_same_as',
    ]);
    expect(owned.viaOwnership).toBe(true);
  });

  it('a Path that is ENTIRELY possibly_same_as hops, with no real edge, is not viaOwnership', async () => {
    if (!(await testDatabaseIsUp())) return;
    const { db } = await seedPsaRoutedFamily();

    const { paths } = await loadNetworkExposurePaths(db, ROOT);
    const psaOnly = paths.find((p) => p.terminalEntityId === PSA_ONLY)!;
    expect(psaOnly.edges.map((e) => e.relationshipType)).toEqual(['possibly_same_as']);
    expect(psaOnly.viaOwnership).toBe(false);
  });

  it('skipping a psa hop does not launder a genuinely non-ownership hop into viaOwnership', async () => {
    if (!(await testDatabaseIsUp())) return;
    const { db } = await seedPsaRoutedFamily();

    const { paths } = await loadNetworkExposurePaths(db, ROOT);
    const tradeAfterPsa = paths.find((p) => p.terminalEntityId === TRADE_AFTER_PSA)!;
    expect(tradeAfterPsa.edges.map((e) => e.relationshipType)).toEqual([
      'possibly_same_as',
      'ships_to',
    ]);
    expect(tradeAfterPsa.viaOwnership).toBe(false);
  });
});

/**
 * `findConcentrations` (network spec §7) — Concentration derived **for free**
 * from Paths tickets 02/03's automatic reads already stored, seeded directly
 * the same way `loadFamilyPaths`'s own suite does above (no enrich pipeline
 * required to prove the read side).
 */
describe('findConcentrations — Concentration derived for free from stored Paths', () => {
  const ROOT_A = 'test-concentration-root-a';
  const ROOT_B = 'test-concentration-root-b';
  const ROOT_C = 'test-concentration-root-c';
  const SHARED_PARENT = 'test-concentration-shared-parent';
  const SHARED_LISTED_ENTITY = 'test-concentration-shared-listed';
  const A_ONLY_TERMINAL = 'test-concentration-a-only';
  const C_ONLY_TERMINAL = 'test-concentration-c-only';
  const SHORTEST_PATH_ONLY_SHARED = 'test-concentration-shortest-path-only';

  async function seedEnrichment(db: Awaited<ReturnType<typeof getTestDb>>, rootEntityId: string) {
    const [upstreamResponse] = await db
      .insert(t.upstreamResponse)
      .values({
        source: 'sayari',
        endpoint: 'traversal.ownership',
        paramsHash: `test-hash-concentration-${rootEntityId}`,
        params: { entityId: rootEntityId },
        body: {},
        bodyHash: `test-body-hash-concentration-${rootEntityId}`,
        via: 'sdk',
      })
      .returning({ id: t.upstreamResponse.id });
    const [enrichment] = await db
      .insert(t.enrichment)
      .values({
        source: 'sayari_ownership_family',
        subjectKind: 'entity',
        subjectKey: rootEntityId,
        requestParams: { entityId: rootEntityId },
        upstreamResponseId: upstreamResponse!.id,
      })
      .returning({ id: t.enrichment.id });
    return enrichment!.id;
  }

  async function seedConcentrationFixture() {
    const db = await getTestDb();
    await resetDerived(db);

    await db.insert(t.entity).values([
      { id: ROOT_A, label: 'Supplier A', country: 'DEU' },
      { id: ROOT_B, label: 'Supplier B', country: 'FRA' },
      { id: ROOT_C, label: 'Supplier C', country: 'ITA' },
      { id: SHARED_PARENT, label: 'Shared Parent Holding', country: 'DEU' },
      { id: SHARED_LISTED_ENTITY, label: 'Shared Listed Entity', country: 'RUS', sanctioned: true },
      { id: A_ONLY_TERMINAL, label: 'Only A reaches this', country: 'ESP' },
      { id: C_ONLY_TERMINAL, label: 'Only C reaches this', country: 'POL' },
      { id: SHORTEST_PATH_ONLY_SHARED, label: 'Shared only via shortest_path', country: 'GBR' },
    ]);

    const enrichmentA = await seedEnrichment(db, ROOT_A);
    const enrichmentB = await seedEnrichment(db, ROOT_B);
    const enrichmentC = await seedEnrichment(db, ROOT_C);

    await db.insert(t.graphPath).values([
      // A's family reaches the shared parent — and a second terminal nobody
      // else reaches, proving the join is on the SHARED row, not on "A has
      // any Path at all".
      {
        rootEntityId: ROOT_A,
        terminalEntityId: SHARED_PARENT,
        kind: 'family',
        direction: 'down',
        hopDepth: 1,
        enrichmentId: enrichmentA,
      },
      {
        rootEntityId: ROOT_A,
        terminalEntityId: A_ONLY_TERMINAL,
        kind: 'family',
        direction: 'down',
        hopDepth: 1,
        enrichmentId: enrichmentA,
      },
      // B's family reaches the SAME shared parent, at a different hop depth
      // and via a separate read — the join `findConcentrations` should find.
      {
        rootEntityId: ROOT_B,
        terminalEntityId: SHARED_PARENT,
        kind: 'family',
        direction: 'down',
        hopDepth: 2,
        enrichmentId: enrichmentB,
      },
      // A and B ALSO both reach a Listed entity on their watchlist Paths —
      // proves the join is not family-only.
      {
        rootEntityId: ROOT_A,
        terminalEntityId: SHARED_LISTED_ENTITY,
        kind: 'watchlist',
        direction: 'either',
        hopDepth: 3,
        enrichmentId: enrichmentA,
      },
      {
        rootEntityId: ROOT_B,
        terminalEntityId: SHARED_LISTED_ENTITY,
        kind: 'watchlist',
        direction: 'either',
        hopDepth: 1,
        enrichmentId: enrichmentB,
      },
      // C's family reaches a terminal neither A nor B reaches at all — the
      // negative case: C is in the queried id set but joined to no one.
      {
        rootEntityId: ROOT_C,
        terminalEntityId: C_ONLY_TERMINAL,
        kind: 'family',
        direction: 'down',
        hopDepth: 1,
        enrichmentId: enrichmentC,
      },
      // A and C both reach one more entity, but only via kind `shortest_path`
      // — the recommend Job's own targeted award-vs-Pick check (network spec
      // §7, a different unit's Job), deliberately excluded from this free
      // derivation. Proves the kind filter, not just the terminal match.
      {
        rootEntityId: ROOT_A,
        terminalEntityId: SHORTEST_PATH_ONLY_SHARED,
        kind: 'shortest_path',
        direction: 'either',
        hopDepth: 1,
        enrichmentId: enrichmentA,
      },
      {
        rootEntityId: ROOT_C,
        terminalEntityId: SHORTEST_PATH_ONLY_SHARED,
        kind: 'shortest_path',
        direction: 'either',
        hopDepth: 1,
        enrichmentId: enrichmentC,
      },
    ]);

    return { db };
  }

  it('joins two entities whose stored Paths reach the same terminal, on every family/watchlist terminal they share', async () => {
    if (!(await testDatabaseIsUp())) return;
    const { db } = await seedConcentrationFixture();

    const pairs = await findConcentrations(db, [ROOT_A, ROOT_B, ROOT_C]);

    // ROOT_A < ROOT_B lexicographically, so the pair reports as (A, B), never
    // the reverse — `findConcentrations`'s own documented dedup rule.
    const sharedParentPair = pairs.find((p) => p.terminalEntityId === SHARED_PARENT);
    expect(sharedParentPair).toEqual({
      entityId: ROOT_A,
      otherEntityId: ROOT_B,
      terminalEntityId: SHARED_PARENT,
      terminalLabel: 'Shared Parent Holding',
    });

    // The watchlist-kind join, alongside the family-kind one — one row per
    // distinct shared terminal, not collapsed into one pair-level fact.
    const sharedListedPair = pairs.find((p) => p.terminalEntityId === SHARED_LISTED_ENTITY);
    expect(sharedListedPair).toEqual({
      entityId: ROOT_A,
      otherEntityId: ROOT_B,
      terminalEntityId: SHARED_LISTED_ENTITY,
      terminalLabel: 'Shared Listed Entity',
    });

    expect(pairs).toHaveLength(2);
  });

  it('reports nothing for an entity whose Paths share no terminal with anyone (the negative case)', async () => {
    if (!(await testDatabaseIsUp())) return;
    const { db } = await seedConcentrationFixture();

    const pairs = await findConcentrations(db, [ROOT_A, ROOT_B, ROOT_C]);
    expect(pairs.some((p) => p.entityId === ROOT_C || p.otherEntityId === ROOT_C)).toBe(false);
  });

  it('never joins on a shared terminal reached only via kind shortest_path', async () => {
    if (!(await testDatabaseIsUp())) return;
    const { db } = await seedConcentrationFixture();

    // A and C share SHORTEST_PATH_ONLY_SHARED, but only through `shortest_path`
    // rows — out of scope for the free derivation (see the fixture's own
    // comment and `findConcentrations`'s doc comment on `CONCENTRATION_KINDS`).
    const pairs = await findConcentrations(db, [ROOT_A, ROOT_C]);
    expect(pairs).toEqual([]);
  });

  it('returns nothing for fewer than two entity ids, without querying', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    expect(await findConcentrations(db, [])).toEqual([]);
    expect(await findConcentrations(db, [ROOT_A])).toEqual([]);
  });
});

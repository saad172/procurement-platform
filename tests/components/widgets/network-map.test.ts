import { describe, expect, it } from 'vitest';
import {
  buildEntityHref,
  buildNetworkElements,
  buildRecordHref,
  DEFAULT_NODE_CAP,
  selectLayoutPlan,
  visibleElements,
  type NetworkMapEdge,
  type NetworkMapPath,
  type NetworkMapRoot,
} from '@/components/widgets/network-map-inner';

/**
 * network spec §8, §12 (ticket 05, unit 05d). Two things this file exists to
 * pin down, per this unit's own brief: the Paths-as-JSON → cytoscape-element
 * transform (`buildNetworkElements`/`visibleElements`), and the >200-node
 * layout-selection logic (`selectLayoutPlan`) — never cytoscape's own
 * pan/zoom/hover mechanics, which are a mature library's job, not this
 * component's.
 */

const ROOT: NetworkMapRoot = { id: 'root-1', label: 'Acme Holdings' };
const PROGRAM_ID = 'prog-1';

function edge(
  overrides: Partial<NetworkMapEdge> & Pick<NetworkMapEdge, 'id' | 'fromEntityId' | 'toEntityId'>,
): NetworkMapEdge {
  return {
    relationshipType: 'owner_of',
    former: false,
    sharePercentage: null,
    startDate: null,
    endDate: null,
    sourceRecordId: null,
    ...overrides,
  };
}

function path(
  overrides: Partial<NetworkMapPath> & Pick<NetworkMapPath, 'terminalEntityId' | 'label' | 'edges'>,
): NetworkMapPath {
  return { ...overrides };
}

describe('buildEntityHref / buildRecordHref — match sections.tsx exactly', () => {
  it('builds the entity href sections.tsx renders for every member table', () => {
    expect(buildEntityHref('prog-1', 'entity-9')).toBe('/program/prog-1/entity/entity-9');
  });

  it('builds the record href, splitting and encoding a slash-joined record id', () => {
    expect(buildRecordHref('prog-1', 'us/dept-of-commerce/entity-list/123')).toBe(
      '/program/prog-1/record/us/dept-of-commerce/entity-list/123',
    );
  });

  it('percent-encodes a record id segment that itself contains reserved characters', () => {
    expect(buildRecordHref('prog-1', 'a b/c&d')).toBe('/program/prog-1/record/a%20b/c%26d');
  });
});

describe('selectLayoutPlan — the >200-node decision, as testable logic', () => {
  it('stays full at or below the cap', () => {
    expect(selectLayoutPlan(200, 200)).toEqual({ strategy: 'full', cap: 200, totalNodeCount: 200 });
    expect(selectLayoutPlan(0, 200)).toEqual({ strategy: 'full', cap: 200, totalNodeCount: 0 });
  });

  it('caps one node past the threshold', () => {
    expect(selectLayoutPlan(201, 200)).toEqual({
      strategy: 'capped',
      cap: 200,
      totalNodeCount: 201,
    });
  });

  it("defaults to DEFAULT_NODE_CAP (200 — spec §12's own framing number) when no cap is given", () => {
    expect(DEFAULT_NODE_CAP).toBe(200);
    expect(selectLayoutPlan(199).strategy).toBe('full');
    expect(selectLayoutPlan(201).strategy).toBe('capped');
  });
});

describe("buildNetworkElements — Paths-as-JSON to the diagram's own node/edge model", () => {
  it('draws just the root when there are no Paths', () => {
    const result = buildNetworkElements([ROOT], [], PROGRAM_ID);
    expect(result.plan).toEqual({ strategy: 'full', cap: DEFAULT_NODE_CAP, totalNodeCount: 1 });
    expect(result.nodes).toEqual([
      expect.objectContaining({ id: 'root-1', label: 'Acme Holdings', kind: 'root', depth: 0 }),
    ]);
    expect(result.edges).toEqual([]);
  });

  it('returns an empty analysis rather than throwing when there is no root', () => {
    const result = buildNetworkElements([], [], PROGRAM_ID);
    expect(result).toEqual({
      plan: { strategy: 'full', cap: DEFAULT_NODE_CAP, totalNodeCount: 0 },
      nodes: [],
      edges: [],
      clusters: [],
      keptNodeIds: [],
      primaryRootId: null,
    });
  });

  it('draws every hop of a multi-edge chain, defaulting an absent `kind` to family', () => {
    const paths: NetworkMapPath[] = [
      path({
        terminalEntityId: 'child-2',
        label: 'Child Two',
        edges: [
          edge({ id: 'e1', fromEntityId: 'root-1', toEntityId: 'child-1' }),
          edge({ id: 'e2', fromEntityId: 'child-1', toEntityId: 'child-2' }),
        ],
      }),
    ];
    const result = buildNetworkElements([ROOT], paths, PROGRAM_ID);

    expect(result.plan.strategy).toBe('full');
    expect(result.nodes).toHaveLength(3);
    const byId = new Map(result.nodes.map((n) => [n.id, n]));
    expect(byId.get('root-1')).toMatchObject({ kind: 'root', depth: 0 });
    expect(byId.get('child-2')).toMatchObject({
      kind: 'family',
      depth: 2,
      label: 'Child Two',
      hasKnownLabel: true,
    });
    // `child-1` is only ever an edge endpoint — no query in this build loads its own label — so
    // it falls back to a shortened id rather than an invented name.
    expect(byId.get('child-1')).toMatchObject({ depth: 1, hasKnownLabel: false });

    expect(result.edges).toHaveLength(2);
    const e1 = result.edges.find((e) => e.id === 'e1')!;
    expect(e1).toMatchObject({ source: 'root-1', target: 'child-1', synthetic: false, href: null });
  });

  it("cites an edge's record through its own sourceRecordId, matching sections.tsx's recordHref", () => {
    const paths: NetworkMapPath[] = [
      path({
        terminalEntityId: 'child-1',
        label: 'Child One',
        edges: [
          edge({
            id: 'e1',
            fromEntityId: 'root-1',
            toEntityId: 'child-1',
            sourceRecordId: 'us/registry/1',
          }),
        ],
      }),
    ];
    const result = buildNetworkElements([ROOT], paths, PROGRAM_ID);
    expect(result.edges[0]!.href).toBe('/program/prog-1/record/us/registry/1');
  });

  it('stands in a synthetic "no citable edge yet" edge for a Path whose edges have not hydrated (migration-0013 gap)', () => {
    const paths: NetworkMapPath[] = [
      path({ terminalEntityId: 'child-1', label: 'Child One', edges: [] }),
    ];
    const result = buildNetworkElements([ROOT], paths, PROGRAM_ID);

    expect(result.nodes.map((n) => n.id).sort()).toEqual(['child-1', 'root-1']);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toMatchObject({
      source: 'root-1',
      target: 'child-1',
      synthetic: true,
      href: null,
      relationshipType: 'no citable edge yet',
    });
  });

  it('dedupes an edge cited by more than one Path (a shared intermediate hop)', () => {
    const shared = edge({ id: 'shared', fromEntityId: 'root-1', toEntityId: 'mid-1' });
    const paths: NetworkMapPath[] = [
      path({ terminalEntityId: 'mid-1', label: 'Mid One', edges: [shared] }),
      path({
        terminalEntityId: 'leaf-1',
        label: 'Leaf One',
        edges: [shared, edge({ id: 'e2', fromEntityId: 'mid-1', toEntityId: 'leaf-1' })],
      }),
    ];
    const result = buildNetworkElements([ROOT], paths, PROGRAM_ID);
    expect(result.edges.filter((e) => e.id === 'shared')).toHaveLength(1);
    expect(result.nodes).toHaveLength(3); // root, mid-1, leaf-1
  });

  it("reads a node's worst risk level and factor names off entity.risk, excluding country-derived factors", () => {
    const paths: NetworkMapPath[] = [
      path({
        terminalEntityId: 'child-1',
        label: 'Risky Co',
        sanctioned: true,
        risk: {
          sanctioned: { level: 'high' },
          cpi_score: { level: 'high', metadata: { country: 'CN' } }, // country-derived — excluded
        },
        edges: [edge({ id: 'e1', fromEntityId: 'root-1', toEntityId: 'child-1' })],
      }),
    ];
    const result = buildNetworkElements([ROOT], paths, PROGRAM_ID);
    const node = result.nodes.find((n) => n.id === 'child-1')!;
    expect(node.level).toBe('high');
    expect(node.factors).toEqual(['sanctioned']);
    expect(node.sanctioned).toBe(true);
  });

  it('caps at N nodes and clusters the overflow by (kind, depth), closest to root kept first', () => {
    const paths: NetworkMapPath[] = Array.from({ length: 5 }, (_, i) => {
      const id = `watch-${i}`;
      return path({
        terminalEntityId: id,
        label: `Watch ${i}`,
        kind: 'watchlist',
        edges: [edge({ id: `we-${i}`, fromEntityId: 'root-1', toEntityId: id })],
      });
    });
    // cap at 3: root + 2 kept individually, 3 clustered (5 watchlist nodes - 2 budget = 3)
    const result = buildNetworkElements([ROOT], paths, PROGRAM_ID, 3);

    expect(result.plan).toEqual({ strategy: 'capped', cap: 3, totalNodeCount: 6 });
    expect(result.keptNodeIds).toHaveLength(3); // root + 2
    expect(result.keptNodeIds).toContain('root-1');
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]).toMatchObject({ kind: 'watchlist', depth: 1, count: 3 });
    expect(result.clusters[0]!.label).toBe('3 more hop-1 watchlist counterparties');
  });

  it('never clusters the root, regardless of cap', () => {
    const result = buildNetworkElements([ROOT], [], PROGRAM_ID, 0);
    expect(result.keptNodeIds).toEqual(['root-1']);
    expect(result.clusters).toEqual([]);
  });
});

describe('visibleElements — expanding a cluster is a free projection over already-loaded Paths', () => {
  function cappedAnalysis() {
    const paths: NetworkMapPath[] = Array.from({ length: 4 }, (_, i) => {
      const id = `watch-${i}`;
      return path({
        terminalEntityId: id,
        label: `Watch ${i}`,
        kind: 'watchlist',
        edges: [edge({ id: `we-${i}`, fromEntityId: 'root-1', toEntityId: id })],
      });
    });
    return buildNetworkElements([ROOT], paths, PROGRAM_ID, 2); // root + 1 kept, 3 clustered
  }

  it('shows only the kept nodes plus a synthetic root→cluster edge when nothing is expanded', () => {
    const analysis = cappedAnalysis();
    const view = visibleElements(analysis, new Set());
    expect(view.nodes).toHaveLength(2); // root + 1 kept watchlist node
    expect(view.clusters).toHaveLength(1);
    expect(view.edges.some((e) => e.target === view.clusters[0]!.id && e.synthetic)).toBe(true);
  });

  it("folds a cluster's real members and their real edge back in once expanded, and drops its synthetic edge", () => {
    const analysis = cappedAnalysis();
    const clusterId = analysis.clusters[0]!.id;
    const view = visibleElements(analysis, new Set([clusterId]));

    expect(view.clusters).toEqual([]);
    expect(view.nodes).toHaveLength(5); // root + the 1 already-kept watchlist node + the 3 previously-clustered ones
    expect(view.edges.some((e) => e.id === `cluster-edge:${clusterId}`)).toBe(false);
    expect(view.edges.filter((e) => e.source === 'root-1')).toHaveLength(4); // 1 kept + 3 expanded, each a real edge
  });

  it('is a pass-through when the strategy is already full', () => {
    const analysis = buildNetworkElements([ROOT], [], PROGRAM_ID);
    const view = visibleElements(analysis, new Set(['nonexistent']));
    expect(view).toEqual({ nodes: analysis.nodes, edges: analysis.edges, clusters: [] });
  });
});

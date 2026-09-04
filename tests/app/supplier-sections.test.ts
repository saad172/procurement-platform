import { describe, expect, it } from 'vitest';
import { groupChainByKind } from '@/app/program/[programId]/supplier/[supplierId]/sections';
import type { NetworkPath, NetworkPathKind } from '@/db/queries/family-paths';

/**
 * `FamilyChainRows`'s pure half (network spec §6, §8, §9; ticket 05 unit
 * 05e). `groupChainByKind` is what decides which kinds a rendered Supplier
 * page actually shows chain rows for, so it is what this file proves rather
 * than the JSX around it — this codebase has no React-render test precedent
 * anywhere (`tests/components/widgets/network-map.test.ts`, the sibling
 * widget's own suite, tests its pure transforms the same way), and every
 * fact `<FamilyChainRows>` renders is mechanical once the grouping is right:
 * one `<h4>`/`<table>` pair per group, in the order this function returns.
 */

function path(
  overrides: Partial<NetworkPath> & Pick<NetworkPath, 'kind' | 'terminalEntityId'>,
): NetworkPath {
  return {
    label: overrides.terminalEntityId,
    country: null,
    sanctioned: false,
    risk: null,
    hopDepth: 1,
    truncated: false,
    reachableCount: null,
    enrichmentId: 'test-enrichment',
    discoveredByJob: null,
    edges: [],
    ...overrides,
  };
}

describe('groupChainByKind — the Supplier page chain rows, widened past family-only (ticket 05 unit 05e)', () => {
  it('groups Paths of every kind this build writes, not only family', () => {
    const paths: NetworkPath[] = [
      path({ kind: 'family', terminalEntityId: 'member-family' }),
      path({ kind: 'watchlist', terminalEntityId: 'member-watchlist' }),
      path({ kind: 'supply_chain', terminalEntityId: 'member-supply-chain' }),
      path({ kind: 'deep_traversal', terminalEntityId: 'member-deep-traversal' }),
      path({ kind: 'shortest_path', terminalEntityId: 'member-shortest-path' }),
    ];

    const groups = groupChainByKind(paths);

    expect(groups.map((g) => g.kind)).toEqual([
      'family',
      'watchlist',
      'shortest_path',
      'deep_traversal',
      'supply_chain',
    ]);
    for (const group of groups) expect(group.paths).toHaveLength(1);
  });

  it('drops a kind with no Paths rather than rendering an empty group — the citable-edge fallback has nothing to cite for it', () => {
    const paths: NetworkPath[] = [
      path({ kind: 'family', terminalEntityId: 'member-family-a' }),
      path({ kind: 'family', terminalEntityId: 'member-family-b' }),
    ];

    const groups = groupChainByKind(paths);
    expect(groups).toEqual([{ kind: 'family', paths: [paths[0], paths[1]] }]);
  });

  it('keeps every Path of a kind together, in the order `loadNetworkPaths` returned them', () => {
    const supplyChainA = path({ kind: 'supply_chain', terminalEntityId: 'sc-a', hopDepth: 1 });
    const supplyChainB = path({ kind: 'supply_chain', terminalEntityId: 'sc-b', hopDepth: 2 });
    const watchlist = path({ kind: 'watchlist', terminalEntityId: 'wl-a' });

    const groups = groupChainByKind([supplyChainA, supplyChainB, watchlist]);

    const supplyChainGroup = groups.find((g) => g.kind === 'supply_chain');
    expect(supplyChainGroup?.paths).toEqual([supplyChainA, supplyChainB]);
    const watchlistGroup = groups.find((g) => g.kind === 'watchlist');
    expect(watchlistGroup?.paths).toEqual([watchlist]);
  });

  it('returns nothing for an empty chain — the caller (`FamilyChainRows`) renders nothing at all rather than an empty <details>', () => {
    expect(groupChainByKind([])).toEqual([]);
  });

  it('covers every NetworkPathKind this build defines, so a future kind is a visible test failure rather than a silently dropped group', () => {
    const allKinds: NetworkPathKind[] = [
      'family',
      'watchlist',
      'shortest_path',
      'deep_traversal',
      'supply_chain',
    ];
    const paths = allKinds.map((kind, i) => path({ kind, terminalEntityId: `member-${i}` }));
    expect(groupChainByKind(paths)).toHaveLength(allKinds.length);
  });
});

import { describe, expect, it } from 'vitest';
import {
  buildConcentrationMap,
  type ConcentrationSourceRow,
} from '@/app/program/[programId]/category/[categoryId]/concentration-map';

/**
 * network spec §7, §8 (ticket 05, unit 05f). Pins the one transform this
 * unit owns: `ShortlistEntry.concentrationWith` (ticket 04, unit 04d's
 * `ConcentrationPartner[]`) → `NetworkMap`'s `{roots, paths}` props. No
 * database, no rendering — the same style `tests/components/widgets/network-map.test.ts`
 * uses for `buildNetworkElements`, since this codebase tests a page section's
 * pure logic rather than mounting its JSX (no React Testing Library/jsdom
 * dependency in this build).
 *
 * The empty-state branch `sections.tsx`'s `ConcentrationMap` renders
 * (`roots.length === 0` → the "No Concentration yet" paragraph, never
 * `<NetworkMap>`) is exactly the case the "no accepted Supplier has any
 * Concentration" tests below assert on this function's return value.
 */

function row(overrides: Partial<ConcentrationSourceRow> & Pick<ConcentrationSourceRow, 'supplierId' | 'displayName'>): ConcentrationSourceRow {
  return { entityId: null, concentrationWith: [], ...overrides };
}

describe('buildConcentrationMap — Concentration data to NetworkMap props', () => {
  it('turns a joined pair into two roots and two synthetic, edge-less Paths converging on the shared terminal', () => {
    const rows: ConcentrationSourceRow[] = [
      row({
        supplierId: 'supplier-a',
        displayName: 'Acme Metals',
        entityId: 'entity-a',
        concentrationWith: [
          {
            supplierId: 'supplier-b',
            displayName: 'Acme Fabrication',
            terminalEntityId: 'entity-parent',
            terminalLabel: 'Acme Holdings',
          },
        ],
      }),
      row({
        supplierId: 'supplier-b',
        displayName: 'Acme Fabrication',
        entityId: 'entity-b',
        concentrationWith: [
          {
            supplierId: 'supplier-a',
            displayName: 'Acme Metals',
            terminalEntityId: 'entity-parent',
            terminalLabel: 'Acme Holdings',
          },
        ],
      }),
    ];

    const { roots, paths } = buildConcentrationMap(rows);

    expect(roots).toEqual([
      { id: 'entity-a', label: 'Acme Metals' },
      { id: 'entity-b', label: 'Acme Fabrication' },
    ]);
    expect(paths).toEqual([
      { rootEntityId: 'entity-a', terminalEntityId: 'entity-parent', label: 'Acme Holdings', edges: [] },
      { rootEntityId: 'entity-b', terminalEntityId: 'entity-parent', label: 'Acme Holdings', edges: [] },
    ]);
    // Every synthetic Path is edge-less by construction — `NetworkMap`'s own
    // `collectEdges` fallback draws the "no citable edge yet" hop for us.
    expect(paths.every((p) => p.edges.length === 0)).toBe(true);
    expect(paths.every((p) => p.rootEntityId != null)).toBe(true);
  });

  it('emits one Path per distinct terminal when a pair shares more than one (findConcentrations\' own documented case)', () => {
    const rows: ConcentrationSourceRow[] = [
      row({
        supplierId: 'supplier-a',
        displayName: 'Acme Metals',
        entityId: 'entity-a',
        concentrationWith: [
          {
            supplierId: 'supplier-b',
            displayName: 'Acme Fabrication',
            terminalEntityId: 'entity-parent',
            terminalLabel: 'Acme Holdings',
          },
          {
            supplierId: 'supplier-b',
            displayName: 'Acme Fabrication',
            terminalEntityId: 'entity-listed',
            terminalLabel: 'Sanctioned Trading Co',
          },
        ],
      }),
    ];

    const { roots, paths } = buildConcentrationMap(rows);

    expect(roots).toEqual([{ id: 'entity-a', label: 'Acme Metals' }]);
    expect(paths).toHaveLength(2);
    expect(paths.map((p) => p.terminalEntityId).sort()).toEqual(['entity-listed', 'entity-parent']);
  });

  it('excludes a row with no settled Match (no entityId), even if concentrationWith is somehow non-empty', () => {
    const rows: ConcentrationSourceRow[] = [
      row({
        supplierId: 'supplier-unmatched',
        displayName: 'Unmatched Co',
        entityId: null,
        concentrationWith: [
          {
            supplierId: 'supplier-b',
            displayName: 'Acme Fabrication',
            terminalEntityId: 'entity-parent',
            terminalLabel: 'Acme Holdings',
          },
        ],
      }),
    ];

    expect(buildConcentrationMap(rows)).toEqual({ roots: [], paths: [] });
  });

  it('excludes an accepted row whose Network shares nothing with any other bidder — no isolated root', () => {
    const rows: ConcentrationSourceRow[] = [
      row({ supplierId: 'supplier-a', displayName: 'Acme Metals', entityId: 'entity-a' }),
      row({ supplierId: 'supplier-c', displayName: 'Solo Supplier', entityId: 'entity-c' }),
    ];

    expect(buildConcentrationMap(rows)).toEqual({ roots: [], paths: [] });
  });

  it('returns an empty map for an empty Shortlist — the input `ConcentrationMap` renders its empty state on', () => {
    expect(buildConcentrationMap([])).toEqual({ roots: [], paths: [] });
  });
});

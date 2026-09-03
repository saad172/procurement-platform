import { describe, expect, it } from 'vitest';
import {
  deriveFamilyCoverageAndExposure,
  deriveFreshestAge,
  deriveOwnRiskFactorCount,
  deriveSupplierRank,
} from '@/domain/derive-supplier-page';

/**
 * The Supplier page reads its family, enrichment and shortlist rows exactly
 * once (`readSupplierRows`); everything here is the pure shaping over those
 * rows that used to live inline in `loadSupplierPage`.
 */

describe('deriveFamilyCoverageAndExposure', () => {
  it('counts rows held for "explored" — safe now that graph_path is unique on (root, terminal, kind)', () => {
    // `family_member` could hold one member twice (Bosch and Magna each once
    // stored 100 rows for 50 members) and reading a row's own counter was how
    // that regression was avoided; `graph_path`'s unique index rules the
    // duplication out at the database, so two distinct members are exactly
    // two rows and `explored` is their count.
    const { coverage } = deriveFamilyCoverageAndExposure([
      {
        member: { id: 'a', label: 'A', country: 'DEU', risk: null },
        hopDepth: 1,
        truncated: true,
        discoveredByJob: null,
        reachableCount: 50,
      },
      {
        member: { id: 'b', label: 'B', country: 'DEU', risk: null },
        hopDepth: 1,
        truncated: false,
        discoveredByJob: null,
        reachableCount: 50,
      },
    ]);
    expect(coverage).toEqual({ explored: 2, reachable: 50, partial: true });
  });

  it('takes the WIDEST envelope, not the first row, when a Deep Traversal has walked further', () => {
    // The automatic read's own envelope (50) and a Deep Traversal's wider one
    // (200) can both be present; the wider envelope's own `truncated` travels
    // with it, and picking the narrower row first would understate a family
    // the app already paid to explore.
    const { coverage } = deriveFamilyCoverageAndExposure([
      {
        member: { id: 'a', label: 'A', country: 'DEU', risk: null },
        hopDepth: 1,
        truncated: true,
        discoveredByJob: null,
        reachableCount: 50,
      },
      {
        member: { id: 'b', label: 'B', country: 'DEU', risk: null },
        hopDepth: 2,
        truncated: false,
        discoveredByJob: 'deep-traversal-job',
        reachableCount: 200,
      },
    ]);
    expect(coverage).toEqual({ explored: 2, reachable: 200, partial: false });
  });

  it('is not_covered when the ownership graph returned nobody', () => {
    const { exposure } = deriveFamilyCoverageAndExposure([]);
    expect(exposure.state).toBe('not_covered');
  });

  it('finds exposure from a family member’s own risk block', () => {
    const { exposure } = deriveFamilyCoverageAndExposure([
      {
        member: {
          id: 'b',
          label: 'B',
          country: 'ROU',
          risk: { exports_bis_high_priority_items_direct: { level: 'high' } },
        },
        hopDepth: 1,
        truncated: false,
        discoveredByJob: null,
        reachableCount: 1,
      },
    ]);
    expect(exposure.state).toBe('exposure_found');
  });
});

describe('deriveOwnRiskFactorCount', () => {
  it('counts zero for a null risk block', () => {
    expect(deriveOwnRiskFactorCount(null)).toBe(0);
  });

  it('counts the factors on the entity’s own risk block', () => {
    expect(deriveOwnRiskFactorCount({ sanctioned: true, pep: true })).toBe(2);
  });
});

describe('deriveFreshestAge', () => {
  it('is null with no enrichments', () => {
    expect(deriveFreshestAge([])).toBeNull();
  });

  it('is the smallest age, not the first row', () => {
    expect(deriveFreshestAge([{ ageDays: 30 }, { ageDays: 2 }, { ageDays: 14 }])).toBe(2);
  });
});

describe('deriveSupplierRank', () => {
  it('reads "not ranked" with no shortlist at all', () => {
    expect(deriveSupplierRank(undefined, 's1')).toBe('not ranked');
  });

  it('reads "not ranked" when the shortlist carries no rank for this supplier', () => {
    const shortlist = { ranked: [], totalCount: 9 };
    expect(deriveSupplierRank(shortlist as never, 's1')).toBe('not ranked');
  });

  it('states the true rank against the total, from the unfiltered shortlist', () => {
    const shortlist = {
      ranked: [{ supplierId: 's1', rank: 6 }],
      totalCount: 9,
    };
    expect(deriveSupplierRank(shortlist as never, 's1')).toBe('6 of 9');
  });
});

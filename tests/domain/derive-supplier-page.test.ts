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
  it('reads the coverage figures the traversal itself reported, not a row count', () => {
    // The regression this guards: the family stored twice for one entity once
    // made the badge read "28 of 100 explored" against a truth of 14 of 50.
    const { coverage } = deriveFamilyCoverageAndExposure([
      {
        member: { id: 'a', label: 'A', country: 'DEU', risk: null },
        exploredCount: 14,
        reachableCount: 50,
      },
      {
        member: { id: 'a', label: 'A', country: 'DEU', risk: null },
        exploredCount: 14,
        reachableCount: 50,
      },
    ]);
    expect(coverage).toEqual({ explored: 14, reachable: 50 });
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
        exploredCount: 1,
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

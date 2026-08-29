import { describe, expect, it } from 'vitest';
import {
  computeFamilyExposure,
  describeFamilyExposure,
  unionRiskFactors,
  type FamilyMemberRisk,
} from '@/domain/family';
import { parseRiskObject } from '@/domain/scoring/risk-factors';

/**
 * SPEC §8. Two things are worth proving here, and both are about what the app
 * refuses to say rather than what it says.
 */

const member = (id: string, risk: Record<string, unknown> = {}): FamilyMemberRisk => ({
  entityId: id,
  label: id.toUpperCase(),
  country: 'ROU',
  factors: parseRiskObject(risk),
  fromDeepTraversal: false,
});

describe('the three badge states, and why the first two are not one state', () => {
  it('reports NOT COVERED when the ownership graph returned nobody', () => {
    // Six of twelve sampled families returned zero members, including several
    // that certainly have subsidiaries. An empty ownership graph is an
    // unexplored family, not a clean one.
    const exposure = computeFamilyExposure([], { explored: 0, reachable: null });
    expect(exposure.state).toBe('not_covered');
    expect(describeFamilyExposure(exposure)).toMatch(/not the same as a clean family/);
  });

  it('reports NO EXPOSURE FOUND when members came back carrying nothing', () => {
    const exposure = computeFamilyExposure([member('a'), member('b')], { explored: 2, reachable: null });
    expect(exposure.state).toBe('no_exposure_found');
  });

  it('renders the two in visibly different words', () => {
    // Collapsing them would report an empty ownership graph in the same ink as
    // a genuinely clean family.
    const notCovered = describeFamilyExposure(computeFamilyExposure([], { explored: 0, reachable: null }));
    const clean = describeFamilyExposure(
      computeFamilyExposure([member('a')], { explored: 1, reachable: null }),
    );
    expect(notCovered).not.toEqual(clean);
    expect(notCovered).toMatch(/Not covered/);
    expect(clean).toMatch(/No exposure found/);
  });

  it('reports EXPOSURE FOUND with the worst level and the member count', () => {
    const exposure = computeFamilyExposure(
      [
        member('romania', { exports_bis_high_priority_items_direct: { level: 'high' } }),
        member('morocco', { forced_labor_something_direct: { level: 'elevated' } }),
        member('clean'),
      ],
      { explored: 17, reachable: 2275 },
    );
    expect(exposure.state).toBe('exposure_found');
    if (exposure.state === 'exposure_found') {
      expect(exposure.worstLevel).toBe('high');
      expect(exposure.membersWithExposure).toBe(2);
      // Named, so a compliance sentence can cite the MEMBER'S OWN entity and
      // record rather than the parent's.
      expect(exposure.members.map((m) => m.entityId).sort()).toEqual(['morocco', 'romania']);
    }
  });

  it('phrases a truncated read as "n of m explored", because an absent member proves nothing', () => {
    const exposure = computeFamilyExposure(
      [member('a', { forced_labor_x_direct: { level: 'high' } })],
      { explored: 17, reachable: 2275 },
    );
    expect(describeFamilyExposure(exposure)).toMatch(/17 of 2,275 explored/);
  });

  it('excludes country-derived factors, as the Compliance criterion does', () => {
    const exposure = computeFamilyExposure(
      [member('a', { cpi_score: { level: 'high', metadata: { country: ['MEX'] } } })],
      { explored: 1, reachable: null },
    );
    // A country's corruption index is not a family member's own exposure.
    expect(exposure.state).toBe('no_exposure_found');
  });
});

describe('unioning risk when two endpoints disagree', () => {
  it('keeps a factor that only one endpoint reported', () => {
    // Measured: one company carried 10 factors in the traversal payload and 6
    // from getEntity, and the four missing included an elevated forced-labour
    // factor. Taking either as authoritative would have dropped it.
    const merged = unionRiskFactors([
      { source: 'traversal', risk: { a: { level: 'high' }, b: { level: 'relevant' } } },
      { source: 'getEntity', risk: { a: { level: 'high' } } },
    ]);
    expect(merged.map((m) => m.factor.name).sort()).toEqual(['a', 'b']);
  });

  it('records which endpoints reported each factor', () => {
    const merged = unionRiskFactors([
      { source: 'traversal', risk: { a: { level: 'high' } } },
      { source: 'getEntity', risk: { a: { level: 'high' } } },
    ]);
    expect(merged[0]!.sources.sort()).toEqual(['getEntity', 'traversal']);
  });

  it('keeps the WORSE level where two endpoints disagree', () => {
    // Understating a risk factor is the more dangerous error.
    const merged = unionRiskFactors([
      { source: 'getEntity', risk: { a: { level: 'elevated' } } },
      { source: 'traversal', risk: { a: { level: 'high' } } },
    ]);
    expect(merged[0]!.factor.level).toBe('high');
  });

  it('keeps a traversal path from whichever endpoint carried one', () => {
    const merged = unionRiskFactors([
      { source: 'getEntity', risk: { a: { level: 'high' } } },
      { source: 'traversal', risk: { a: { level: 'high', metadata: { traversal_path: ['x', 'y'] } } } },
    ]);
    expect(merged[0]!.factor.traversalPath).toEqual(['x', 'y']);
  });
});

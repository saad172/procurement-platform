import { describe, expect, it } from 'vitest';
import {
  sayariGetEntity,
  sayariTraversal,
  sayariTraversalOwnership,
  sayariTraversalUbo,
} from '@/upstream/endpoints';
import { canonicalParams, hashParams } from '@/upstream/hash';
import { loadFixture } from '@/fixtures/load';
import type { FixtureUpstreamRow } from '@/fixtures/types';

/**
 * `getEntity` and the three traversal rows' own `normalizeParams` (N5).
 *
 * Array-valued params (`relationships`, `riskCategories`, `countries`;
 * `getEntity`'s `relationshipsCountry`/`ArrivalCountry`/`DepartureCountry`/
 * `PartnerRisk`) used to enter `params_hash` verbatim: `[]` vs omitted, and a
 * reordered array, hashed differently for what is the identical wire request.
 */
describe('normalizeParams drops empty arrays and sorts array values (N5)', () => {
  it.each([
    ['sayariTraversalOwnership', sayariTraversalOwnership],
    ['sayariTraversalUbo', sayariTraversalUbo],
    ['sayariTraversal', sayariTraversal],
  ] as const)('%s: an empty array normalizes the same as an omitted key', (_name, endpoint) => {
    const withEmpty = endpoint.normalizeParams({ id: 'x', relationships: [] });
    const omitted = endpoint.normalizeParams({ id: 'x' });
    expect(withEmpty).toEqual(omitted);
    expect(withEmpty).not.toHaveProperty('relationships');
  });

  it.each([
    ['sayariTraversalOwnership', sayariTraversalOwnership],
    ['sayariTraversalUbo', sayariTraversalUbo],
    ['sayariTraversal', sayariTraversal],
  ] as const)('%s: a reordered array normalizes identically', (_name, endpoint) => {
    const forward = endpoint.normalizeParams({
      id: 'x',
      relationships: ['shareholder_of', 'has_officer'],
      countries: ['USA', 'CHN'],
    });
    const reversed = endpoint.normalizeParams({
      id: 'x',
      relationships: ['has_officer', 'shareholder_of'],
      countries: ['CHN', 'USA'],
    });
    expect(forward).toEqual(reversed);
  });

  it('getEntity: an empty relationshipsCountry array normalizes the same as an omitted key', () => {
    const withEmpty = sayariGetEntity.normalizeParams({ id: 'x', relationshipsCountry: [] });
    const omitted = sayariGetEntity.normalizeParams({ id: 'x' });
    expect(withEmpty).toEqual(omitted);
  });

  it('getEntity: a reordered relationshipsCountry array normalizes identically', () => {
    const forward = sayariGetEntity.normalizeParams({
      id: 'x',
      relationshipsCountry: ['USA', 'MEX'],
    });
    const reversed = sayariGetEntity.normalizeParams({
      id: 'x',
      relationshipsCountry: ['MEX', 'USA'],
    });
    expect(forward).toEqual(reversed);
  });

  /**
   * **No calls before N5 ever sent an array**, so every recorded
   * `params_hash` must hold unchanged. Computed here from a recorded
   * `enrich/yazaki` fixture row's own `params` (`{id, limit}`, no array at
   * all) and compared against the hash that fixture actually stored.
   */
  it("the automatic family read's params_hash is unchanged from main", async () => {
    const fixture = await loadFixture('enrich/yazaki');
    const row = fixture.upstream.find(
      (r: FixtureUpstreamRow) => r.endpoint === 'traversal.ownership',
    );
    expect(row, 'the fixture should hold a traversal.ownership row').toBeTruthy();

    const normalized = canonicalParams(
      sayariTraversalOwnership.normalizeParams(row!.params as never),
    );
    const recomputed = hashParams('traversal.ownership', normalized);
    expect(recomputed).toBe(row!.paramsHash);
  });
});

import { describe, expect, it } from 'vitest';
import { downstreamQuery } from '@/upstream/endpoints';

/**
 * `downstreamQuery`'s wire mapping, for all three traversal rows —
 * `ownership`, `ubo` and `traversal` (ticket 01 item B). Copied from
 * `node_modules/@sayari/sdk/api/resources/traversal/client/Client.js`.
 */
describe('downstreamQuery (SPEC §16.6)', () => {
  it('omits every key when nothing is set', () => {
    const query = downstreamQuery({});
    for (const value of Object.values(query)) expect(value).toBeUndefined();
  });

  it.each([
    ['limit', 50, 'limit', 50],
    ['offset', 50, 'offset', 50],
    ['minDepth', 1, 'min_depth', 1],
    ['maxDepth', 4, 'max_depth', 4],
    ['minShares', 25, 'min_shares', 25],
    ['excludeClosedEntities', true, 'exclude_closed_entities', true],
    ['sanctioned', true, 'sanctioned', true],
    ['pep', true, 'pep', true],
    ['psa', false, 'psa', false],
  ] as const)('maps camelCase %s to snake_case %s', (camel, value, wireKey, wireValue) => {
    const query = downstreamQuery({ [camel]: value });
    expect(query[wireKey as keyof typeof query]).toBe(wireValue);
    for (const [key, v] of Object.entries(query)) {
      if (key !== wireKey) expect(v, key).toBeUndefined();
    }
  });

  it('carries relationships and countries as arrays (repeat encoding)', () => {
    const query = downstreamQuery({
      relationships: ['shareholder_of', 'has_subsidiary'],
      countries: ['USA', 'CHN'],
    });
    expect(query.relationships).toEqual(['shareholder_of', 'has_subsidiary']);
    expect(query.countries).toEqual(['USA', 'CHN']);
  });

  it('JSON-stringifies riskCategories into one risk_categories param', () => {
    const query = downstreamQuery({ riskCategories: ['sanctions', 'export_controls'] });
    expect(query.risk_categories).toBe(JSON.stringify(['sanctions', 'export_controls']));
  });

  it('leaves the automatic family read (no depth, no filters) with an all-undefined query', () => {
    // The unfiltered Corporate family read sends only `limit`; every new
    // field must stay undefined so params_hash and its fixtures hold.
    const query = downstreamQuery({ limit: 50 });
    expect(query.limit).toBe(50);
    const { limit: _limit, ...rest } = query;
    for (const [key, v] of Object.entries(rest)) expect(v, key).toBeUndefined();
  });
});

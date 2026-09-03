import { describe, expect, it } from 'vitest';
import { downstreamQuery } from '@/upstream/endpoints';

/**
 * `downstreamQuery`'s wire mapping, for all four traversal rows —
 * `ownership`, `ubo`, `watchlist` and `traversal` (ticket 01 item B).
 * Field names copied from `node_modules/@sayari/sdk/api/resources/traversal/
 * client/Client.js`; the `risk_categories` encoding itself is not (03f — see
 * that test's own doc comment below).
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
    ['excludeFormerRelationships', true, 'exclude_former_relationships', true],
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

  it('carries relationships, types and countries as arrays (repeat encoding)', () => {
    const query = downstreamQuery({
      relationships: ['shareholder_of', 'has_subsidiary'],
      types: ['company'],
      countries: ['USA', 'CHN'],
    });
    expect(query.relationships).toEqual(['shareholder_of', 'has_subsidiary']);
    expect(query.types).toEqual(['company']);
    expect(query.countries).toEqual(['USA', 'CHN']);
  });

  /**
   * 03f: this used to assert `JSON.stringify(riskCategories)`, mirroring the
   * SDK's own `ownership`/`ubo`/`watchlist`/`traversal` branches on the
   * (wrong) assumption that copying the SDK byte-for-byte was automatically
   * safe. Live-verified against `/v1/downstream/{id}` with a real entity:
   * that JSON-stringified form comes back `422 "Invalid risk category
   * '[\"sanctions\",\"export_controls\"]'"` — for one element or many, it
   * makes no difference — while the same values sent as repeated
   * `risk_categories=` keys come back `200`. So this now passes the array
   * straight through, the same as `relationships`/`types`/`countries` above;
   * `encodeQuery` (`dispatchers/sayari.ts`) is what turns it into repeated
   * keys on the wire (asserted end-to-end in
   * `risk-categories-dispatch.test.ts`).
   */
  it('carries a populated riskCategories as an array (repeat encoding), not JSON-stringified', () => {
    const query = downstreamQuery({ riskCategories: ['sanctions', 'export_controls'] });
    expect(query.risk_categories).toEqual(['sanctions', 'export_controls']);
  });

  /** C5: the SDK's own branch — a bare string (a custom, non-enum category)
   * goes through verbatim, never JSON-encoded. `TraversalWalkParams` only
   * ever declares the array form, so this defends runtime data the type
   * itself would refuse — hence the cast. */
  it('sends a bare-string riskCategories verbatim, not JSON-encoded', () => {
    const query = downstreamQuery({ riskCategories: 'custom_category' as never });
    expect(query.risk_categories).toBe('custom_category');
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

import { describe, expect, it } from 'vitest';
import { limitOffsetQuery } from '@/upstream/endpoints';

/**
 * `limitOffsetQuery`'s wire mapping, for the two raw fallbacks that share it —
 * `trade.searchSuppliers` and `search.searchEntity` (PR #18 review; BUILD-NOTES
 * finding 155 follow-up). Copied from `node_modules/@sayari/sdk/dist/api/
 * resources/trade/client/Client.js` (~205-225) and `.../search/client/
 * Client.js` (~92-108): both destructure `{ limit, offset }` out of the
 * request and set exactly `_queryParams["limit"]` / `_queryParams["offset"]`
 * — nothing else goes in the query string, and `q`/`filter` stay in the body.
 *
 * Same style as `getEntityQuery` and `downstreamQuery`'s own tests.
 */
describe('limitOffsetQuery (SPEC §16.6)', () => {
  it('omits both keys when neither is set', () => {
    const query = limitOffsetQuery({});
    expect(query.limit).toBeUndefined();
    expect(query.offset).toBeUndefined();
  });

  it.each([
    ['limit', 100, 'limit'],
    ['offset', 200, 'offset'],
  ] as const)('carries %s through as %s, and only %s', (camel, value, wireKey) => {
    const query = limitOffsetQuery({ [camel]: value });
    expect(query[wireKey as keyof typeof query]).toBe(value);
    for (const [key, v] of Object.entries(query)) {
      if (key !== wireKey) expect(v, key).toBeUndefined();
    }
  });

  it('carries both at once, and nothing else the SDK does not query on', () => {
    const query = limitOffsetQuery({ limit: 100, offset: 200 });
    expect(query).toEqual({ limit: 100, offset: 200 });
    expect(Object.keys(query).sort()).toEqual(['limit', 'offset']);
  });
});

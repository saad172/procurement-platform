import { describe, expect, it } from 'vitest';
import { loadFixture } from '@/fixtures/load';
import { traversalSchema } from '@/upstream/projections/sayari';
import type { FixtureUpstreamRow } from '@/fixtures/types';

/**
 * `path[].relationships` (ticket 01 item E): previously `z.unknown()`, now a
 * named, lenient shape — keyed by relationship type, each carrying `former`,
 * `start_date`/`end_date`, `attributes.shares` and every edge's `record` id.
 *
 * Two kinds of proof: a small, readable hand-built body (below), and every
 * recorded traversal body this repo has committed, parsed whole, so a shape
 * this test did not think to hand-write cannot slip past it silently.
 */
describe('path[].relationships — hand-built', () => {
  const body = {
    data: [
      {
        path: [
          {
            field: 'shareholder_of',
            entity: 'someEntityId',
            relationships: {
              shareholder_of: {
                former: true,
                startDate: '2018-08-01',
                endDate: '2020-04-07',
                lastObserved: '2020-04-07',
                relationship_status: 'inactive',
                mostRecentPercentage: 30,
                values: [
                  {
                    former: true,
                    record: 'b6382672c6741fe1bca28d2668c1732b/1319687/1560351943539',
                    fromDate: '2018-08-01',
                    toDate: '2020-04-07',
                    acquisitionDate: '2018-08-01',
                    publicationDate: '2018-05-15',
                    relationshipStatus: 'inactive',
                    attributes: {
                      shares: [{ currency: 'USD', percentage: 30, monetary_value: 900_000 }],
                    },
                  },
                ],
              },
            },
          },
        ],
        source: 'rootEntityId',
        target: 'someEntityId',
      },
    ],
  };

  it('keeps the relationship type as the key, and every named field beneath it', () => {
    const parsed = traversalSchema.parse(body);
    const rels = parsed.data?.[0]?.path?.[0]?.relationships;
    expect(rels).toBeTruthy();
    const group = rels?.shareholder_of;
    expect(group?.former).toBe(true);
    expect(group?.start_date).toBe('2018-08-01');
    expect(group?.end_date).toBe('2020-04-07');
    expect(group?.relationship_status).toBe('inactive');
    expect(group?.most_recent_percentage).toBe(30);
    expect(group?.values).toHaveLength(1);
  });

  it('keeps the edge record id and attributes.shares on each value', () => {
    const parsed = traversalSchema.parse(body);
    const value = parsed.data?.[0]?.path?.[0]?.relationships?.shareholder_of?.values?.[0];
    expect(value?.record).toBe('b6382672c6741fe1bca28d2668c1732b/1319687/1560351943539');
    expect(value?.from_date).toBe('2018-08-01');
    expect(value?.to_date).toBe('2020-04-07');
    expect(value?.former).toBe(true);
    const share = value?.attributes?.shares?.[0];
    expect(share?.currency).toBe('USD');
    expect(share?.percentage).toBe(30);
    expect(share?.monetary_value).toBe(900_000);
  });

  it('keeps a source-specific share key it does not name, via .loose()', () => {
    const withOddKeys = {
      data: [
        {
          path: [
            {
              relationships: {
                shareholder_of: {
                  values: [
                    {
                      record: 'x/1/1',
                      attributes: { shares: [{ percentage: 10, 'Share Type': 'Common' }] },
                    },
                  ],
                },
              },
            },
          ],
        },
      ],
    };
    const parsed = traversalSchema.parse(withOddKeys);
    const share = parsed.data?.[0]?.path?.[0]?.relationships?.shareholder_of?.values?.[0]
      ?.attributes?.shares?.[0] as Record<string, unknown> | undefined;
    expect(share?.percentage).toBe(10);
    // `snakeKeys` lowercases every key but only inserts `_` between a
    // lowercase/digit and an immediately-following uppercase letter — a
    // space in a source-specific key like `"Share Type"` survives, just
    // lowercased, to `"share type"` (`key-case.ts`).
    expect(share?.['share type']).toBe('Common');
  });
});

/**
 * Every recorded traversal body this repo has committed, parsed whole through
 * `traversalSchema` — no live call, reading only the two fixtures already in
 * the tree. Proves the named shape does not throw on real data, including the
 * mixed camelCase/snake_case a single relationship group can carry
 * (`relationshipStatus` alongside `relationship_status`, `most_recent_percentage`
 * unconverted) once `snakeKeys` has run.
 */
describe('path[].relationships — recorded fixtures', () => {
  it.each(['traverse/yazaki', 'enrich/yazaki'])('parses every traversal body in %s', async (name) => {
    const fixture = await loadFixture(name);
    const traversalRows = fixture.upstream.filter(
      (row: FixtureUpstreamRow) => row.source === 'sayari' && row.endpoint.startsWith('traversal.'),
    );
    expect(traversalRows.length).toBeGreaterThan(0);

    let relationshipGroupsSeen = 0;
    for (const row of traversalRows) {
      const parsed = traversalSchema.parse(row.body);
      for (const path of parsed.data ?? []) {
        for (const step of path.path ?? []) {
          if (!step.relationships) continue;
          relationshipGroupsSeen += Object.keys(step.relationships).length;
          for (const group of Object.values(step.relationships)) {
            for (const value of group.values ?? []) {
              // A record id, when present, is always a single string — never
              // an array, unlike an attribute entry's `record`.
              if (value.record !== undefined && value.record !== null) {
                expect(typeof value.record).toBe('string');
              }
            }
          }
        }
      }
    }
    // At least one relationship survived projection on real data — proves
    // this is not vacuously true over an empty walk.
    expect(relationshipGroupsSeen).toBeGreaterThan(0);
  });
});

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ENDPOINTS, sayariEntitySummary, sayariTradeSearchSuppliers, sayariTraversalUbo } from '@/upstream/endpoints';
import { entitySummarySchema } from '@/upstream/projections/sayari';

/**
 * The test the `ENDPOINTS` comment promises (SPEC §16.2: "Every endpoint, so
 * a test can quantify over them") — which, before this ticket, did not exist:
 * `sayariTraversalUbo` had sat outside `ENDPOINTS` since it was written, an
 * endpoint nothing could ever call through `call()`, undetected because
 * nothing quantified over the table to notice the gap (ticket 01 item C).
 *
 * This file is that quantifier, and both gaps the audit found are named
 * below: `sayariTraversalUbo` (item C) and the new `entitySummary` row
 * (item A2).
 */
describe('ENDPOINTS (SPEC §16.2)', () => {
  const rows = Object.entries(ENDPOINTS);

  it('gives every row a unique, source-qualified endpoint name', () => {
    const names = rows.map(([, row]) => row.endpoint);
    expect(new Set(names).size).toBe(names.length);
    for (const [key, row] of rows) {
      expect(row.endpoint, `${key}.endpoint`).toBeTruthy();
      expect(row.source, `${key}.source`).toBeTruthy();
    }
  });

  it('gives every row the machinery call() depends on', () => {
    for (const [key, row] of rows) {
      expect(typeof row.timeoutMs, `${key}.timeoutMs`).toBe('number');
      expect(row.timeoutMs, `${key}.timeoutMs`).toBeGreaterThan(0);
      expect(typeof row.normalizeParams, `${key}.normalizeParams`).toBe('function');
      expect(typeof row.dispatch, `${key}.dispatch`).toBe('function');
      expect(row.defaults, `${key}.defaults`).toBeTypeOf('object');
      // Every projection is a zod schema, so a caller never sees an SDK type.
      expect(row.projection, `${key}.projection`).toBeInstanceOf(z.ZodType);
    }
  });

  it('registers sayariEntitySummary (ticket 01 item A2)', () => {
    expect(ENDPOINTS.sayariEntitySummary).toBe(sayariEntitySummary);
    expect(sayariEntitySummary.endpoint).toBe('entity.entitySummary');
    // Its own recorded bucket (N6) — see the row's own doc comment.
    expect(sayariEntitySummary.bucket).toBe('entity_summary');
    expect(sayariEntitySummary.defaults).toEqual({});
  });

  it('registers sayariTraversalUbo (ticket 01 item C)', () => {
    expect(ENDPOINTS.sayariTraversalUbo).toBe(sayariTraversalUbo);
    expect(sayariTraversalUbo.endpoint).toBe('traversal.ubo');
    expect(sayariTraversalUbo.bucket).toBe('traversal');
    // Same shape as the automatic family read (`traversal.ownership`): no
    // depth default, so the Deep Traversal caller's own depth sits in
    // params_hash undisturbed.
    expect(sayariTraversalUbo.defaults).toEqual({ limit: 50 });
  });

  /**
   * `offset` on `sayariTradeSearchSuppliers` (BUILD-NOTES finding 155
   * follow-up, ticket 01 item C). No default, deliberately: `defaults`
   * still reads exactly `{ limit: 100 }`, so `params_hash` for every call
   * that never asks for a page past the first is unchanged.
   */
  it('adds offset to sayariTradeSearchSuppliers with no default', () => {
    expect(ENDPOINTS.sayariTradeSearchSuppliers).toBe(sayariTradeSearchSuppliers);
    expect(sayariTradeSearchSuppliers.endpoint).toBe('trade.searchSuppliers');
    expect(sayariTradeSearchSuppliers.defaults).toEqual({ limit: 100 });
    expect(sayariTradeSearchSuppliers.defaults).not.toHaveProperty('offset');
  });
});

/**
 * `entitySummarySchema` against a hand-built body shaped like the SDK's own
 * documented example (`node_modules/@sayari/sdk/api/resources/entity/types/
 * EntitySummaryResponse.d.ts`) — camelCase, as the SDK path deserialises it.
 * No fixture exists yet for a live `entitySummary` call (see the PR's
 * Re-record list), so this is the hand-built stand-in the project's own
 * conventions call for (`tests/upstream/sayari-attributes.test.ts`).
 */
describe('entitySummarySchema', () => {
  const sdkBody = {
    id: 'mGq1lpuqKssNWTjIokuPeA',
    label: 'VICTORIA BECKHAM LIMITED',
    degree: 114,
    entityUrl: '/entity/mGq1lpuqKssNWTjIokuPeA',
    pep: false,
    psaId: '65455301594691',
    psaCount: 4,
    sanctioned: false,
    closed: false,
    companyType: 'LADIES FASHION',
    registrationDate: 'Incorporated 2008-02-28',
    latestStatus: { status: 'active', date: '2023-08-29' },
    type: 'company',
    identifiers: [{ value: '06517802', type: 'uk_company_number', label: 'Uk Company Number' }],
    addresses: ['202 HAMMERSMITH ROAD , LONDON , , UNITED KINGDOM , W6 7DN , GB'],
    countries: ['GBR', 'USA'],
    relationshipCount: { linked_to: 3, has_officer: 2 },
    sourceCount: {
      '2b618f1996252fe537a6d998ae14c9b2': { count: 1, label: 'UK Corporate Registry' },
    },
    risk: {
      basel_aml: { value: 4.28, metadata: { country: ['USA'] }, level: 'relevant' },
    },
    // The block this row's doc comment says survives: attributes.address with
    // the same parsed properties getEntity returns.
    attributes: {
      address: {
        offset: 0,
        limit: 50,
        // A bare `false`, exactly as the SDK's own documented example shows
        // (C2) — `attributeBlock.next` accepts both a cursor string and this.
        next: false,
        size: { count: 1, qualifier: 'eq' },
        data: [
          {
            properties: {
              value: '202 HAMMERSMITH ROAD , LONDON , , UNITED KINGDOM , W6 7DN , GB',
              houseNumber: '202',
              road: 'Hammersmith Road',
              city: 'London',
              postcode: 'W6 7DN',
              country: 'GBR',
              x: -0.222,
              y: 51.493,
            },
            record: ['9aef3a56aa0ea25404b498dbd8bb447f/06517802/1579014552807'],
            recordCount: 98,
          },
        ],
      },
    },
    possiblySameAs: { data: [] },
    referencedBy: { limit: 1, size: { count: 216, qualifier: 'eq' }, data: [] },
  };

  it('projects every field toCandidateFacts reads off getEntity', () => {
    const parsed = entitySummarySchema.parse(sdkBody);
    expect(parsed.label).toBe('VICTORIA BECKHAM LIMITED');
    expect(parsed.countries).toEqual(['GBR', 'USA']);
    expect(parsed.company_type).toBe('LADIES FASHION');
    expect(parsed.closed).toBe(false);
    expect((parsed.latest_status as { status?: string }).status).toBe('active');
    expect(parsed.identifiers).toHaveLength(1);
    expect(parsed.sanctioned).toBe(false);
    expect(parsed.pep).toBe(false);
    expect(parsed.psa_count).toBe(4);
    expect(parsed.relationship_count).toEqual({ linked_to: 3, has_officer: 2 });
    expect(parsed.source_count).toBeTruthy();
    expect(parsed.risk?.basel_aml?.level).toBe('relevant');
  });

  it('keeps the parsed attributes.address block (city/postcode/country/value)', () => {
    const parsed = entitySummarySchema.parse(sdkBody);
    const addressEntry = parsed.attributes?.address?.data?.[0];
    expect(addressEntry?.properties?.city).toBe('London');
    expect(addressEntry?.properties?.postcode).toBe('W6 7DN');
    expect(addressEntry?.properties?.country).toBe('GBR');
    expect(addressEntry?.properties?.value).toContain('HAMMERSMITH ROAD');
  });

  /** C2: a summary attribute block's `next` is a bare boolean, not a cursor string. */
  it('accepts a boolean `next` on a summary attribute block', () => {
    const parsed = entitySummarySchema.parse(sdkBody);
    expect(parsed.attributes?.address?.next).toBe(false);
  });

  it('accepts a body with no relationships block at all', () => {
    // entitySummary never sends one; the schema declares no such field, so a
    // body without it parses exactly like a body that could never have one.
    expect(() => entitySummarySchema.parse(sdkBody)).not.toThrow();
    expect('relationships' in entitySummarySchema.parse(sdkBody)).toBe(false);
  });
});

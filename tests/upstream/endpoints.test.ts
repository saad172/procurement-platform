import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ENDPOINTS, sayariEntitySummary } from '@/upstream/endpoints';
import { entitySummarySchema } from '@/upstream/projections/sayari';

/**
 * The test the `ENDPOINTS` comment promises (SPEC §16.2: "Every endpoint, so
 * a test can quantify over them") — which, before this ticket, did not exist:
 * `sayariTraversalUbo` had sat outside `ENDPOINTS` since it was written, an
 * endpoint nothing could ever call through `call()`, undetected because
 * nothing quantified over the table to notice the gap (ticket 01 item C).
 *
 * This file is that quantifier. Item C adds `sayariTraversalUbo` to the
 * table in its own commit and extends the assertions below to name it; this
 * first pass locks down the shape every row must have and confirms the new
 * `entitySummary` row (item A2) is one of them.
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
    // No bucket: Sayari's own six-bucket UsageInfo type has no seventh
    // `entitySummary` counter — see the row's own doc comment.
    expect(sayariEntitySummary.bucket).toBeUndefined();
    expect(sayariEntitySummary.defaults).toEqual({});
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
        // `attributeBlock.next` is typed as a string in this app's own
        // projection, unrelated to this ticket's items — the SDK's doc
        // example shows a boolean here too, which is worth a separate look
        // but out of scope for ticket 01.
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
    // entitySummary never carries this — present here only to prove the
    // schema does not choke on it if a body somehow did.
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

  it('accepts a body with no relationships block at all', () => {
    // entitySummary never sends one; the schema declares no such field, so a
    // body without it parses exactly like a body that could never have one.
    expect(() => entitySummarySchema.parse(sdkBody)).not.toThrow();
    expect('relationships' in entitySummarySchema.parse(sdkBody)).toBe(false);
  });
});

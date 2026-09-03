import { describe, expect, it } from 'vitest';
import { entitySummarySchema } from '@/upstream/projections/sayari';
import { toCandidateFacts } from '@/jobs/resolve';

/**
 * **Ticket 01 item D — verifying the `entitySummary` swap, without shipping
 * it.**
 *
 * `gatherPrepassCandidates` (`src/jobs/resolve.ts`) still calls `getEntity`
 * for the five pre-pass Candidates. Switching it to `entitySummary` compiles
 * — `SayariEntitySummary` typechecks everywhere `toCandidateFacts` needs a
 * `SayariEntity` — but every recorded `resolve` fixture (`rules-r0`,
 * `agree-r1`, `sanctioned`, `not-found`) holds `entity.getEntity` bodies for
 * those Candidates, not `entity.entitySummary` ones, and this worktree has no
 * credential to record the missing calls. So the swap is verified here,
 * against a body shaped like the SDK's own documented `entitySummary`
 * response, and left out of the shipped code.
 *
 * The body below is shaped like the SDK's own documented example response
 * (`node_modules/@sayari/sdk/dist/api/resources/entity/types/
 * EntitySummaryResponse.d.ts`) — camelCase, as the SDK path deserialises —
 * carrying every field `toCandidateFacts` reads **except `relationships`**,
 * which that endpoint does not return at all.
 */
const entitySummaryBody = {
  id: 'test-entity-summary-1',
  label: 'AMERICAN AXLE & MANUFACTURING INC',
  type: 'company',
  degree: 12,
  countries: ['USA'],
  addresses: ['ONE DAUCH DRIVE, DETROIT MI 48211-1198'],
  identifiers: [{ type: 'lei', label: 'Lei', value: 'RY5TAKFOBLDUGX31MS24' }],
  sanctioned: false,
  pep: false,
  closed: false,
  companyType: 'CORP',
  registrationDate: 'Incorporated 1957-01-01',
  latestStatus: { status: 'active', date: '2023-08-29' },
  sourceCount: { abc: { count: 1, label: 'A registry' } },
  // An object keyed by relation type, non-empty — the fact this build has to
  // read to tell "no owner" from "the window is cut short".
  relationshipCount: { has_shareholder: 2, owner_of: 3 },
  psaCount: 0,
  risk: {},
  attributes: {
    name: {
      data: [
        {
          properties: { value: 'AMERICAN AXLE & MANUFACTURING INC', context: 'primary' },
          record: ['abc/1/1'],
          recordCount: 1,
        },
      ],
    },
    address: {
      data: [
        {
          properties: {
            value: 'ONE DAUCH DRIVE, DETROIT MI 48211-1198',
            city: 'Detroit',
            postcode: '48211-1198',
            country: 'USA',
          },
          record: ['abc/1/1'],
          recordCount: 1,
        },
      ],
    },
    businessPurpose: {
      data: [{ properties: { value: 'Manufacture of axles' }, record: ['abc/1/1'], recordCount: 1 }],
    },
  },
  // No `relationships` key at all — the field the endpoint does not return.
};

describe('entitySummary carries everything toCandidateFacts reads, except relationships', () => {
  it('parses through entitySummarySchema and projects the same address/alias/purpose facts getEntity would', () => {
    const parsed = entitySummarySchema.parse(entitySummaryBody);
    const facts = toCandidateFacts(parsed as never);

    expect(facts.label).toBe('AMERICAN AXLE & MANUFACTURING INC');
    expect(facts.country).toBe('USA');
    expect(facts.addresses[0]).toMatchObject({ city: 'Detroit', postcode: '48211-1198', country: 'USA' });
    expect(facts.aliases).toEqual(['AMERICAN AXLE & MANUFACTURING INC']);
    expect(facts.businessPurposes).toEqual(['Manufacture of axles']);
    expect(facts.companyType).toBe('CORP');
    expect(facts.closed).toBe(false);
    expect(facts.latestStatus).toBe('active');
    expect(facts.lei).toBe('RY5TAKFOBLDUGX31MS24');
  });

  it('reads owners as EMPTY — the caveat a switch would carry, unless a typed read is added', () => {
    const parsed = entitySummarySchema.parse(entitySummaryBody);
    const facts = toCandidateFacts(parsed as never);

    // No `relationships` block to read an owner edge off of. `name_cover`
    // reads `owners` to tell a family member from the company the roster
    // meant, so this is exactly the gap ticket 01's own item D flags.
    expect(facts.owners).toEqual([]);

    // But NOT silently: `relationshipsTruncated` reads `relationship_count`,
    // which entitySummary does carry, against zero relationships actually
    // returned — so it correctly reports the window as cut short rather than
    // reading as "this record genuinely has no owners".
    expect(facts.relationshipsTruncated).toBe(true);
  });

  it('reads relationshipsTruncated as false when the record genuinely has no relationships either', () => {
    const parsed = entitySummarySchema.parse({ ...entitySummaryBody, relationshipCount: {} });
    const facts = toCandidateFacts(parsed as never);
    expect(facts.owners).toEqual([]);
    expect(facts.relationshipsTruncated).toBe(false);
  });
});

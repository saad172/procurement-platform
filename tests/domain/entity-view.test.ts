import { describe, expect, it } from 'vitest';
import { toEntityView } from '@/domain/entity-view';
import type { SayariEntity } from '@/upstream/projections/sayari';

/**
 * The projection exists because a Sayari entity is a graph node with every edge
 * attached: three raw `sayari_get_entity` calls put 703,956 tokens through a
 * resolve Round and fired the 400,000-token ceiling on a Round that had already
 * produced a usable proposal.
 *
 * So these tests are about **what stays true when things are dropped**. A cap
 * that silently truncates is worse than no cap: it is how a model comes to
 * write "the entity has 25 addresses".
 */

function entity(overrides: Partial<SayariEntity> = {}): SayariEntity {
  return { id: 'e1', label: 'ACME GMBH', ...overrides } as SayariEntity;
}

describe('toEntityView', () => {
  it('keeps the identity fields a Discriminator reads', () => {
    const view = toEntityView(
      entity({
        countries: ['DEU'],
        company_type: 'GmbH',
        registration_date: '1886-11-15',
        sanctioned: false,
        pep: false,
        closed: false,
      }),
    );
    expect(view).toMatchObject({
      id: 'e1',
      label: 'ACME GMBH',
      country: 'DEU',
      companyType: 'GmbH',
      registrationDate: '1886-11-15',
      sanctioned: false,
    });
  });

  it('counts sources rather than listing them, because source_count is an object', () => {
    // `source_count` is keyed by source hash. Its size is the number, and the
    // hashes say nothing a model can use.
    const view = toEntityView(entity({ source_count: { a: 1, b: 2, c: 3 } as never }));
    expect(view.sourceCount).toBe(3);
  });

  it('keeps every address up to the cap, and reports the true total', () => {
    // The Bosch decoy turns on the twelfth of nineteen addresses, so a
    // first-address-only view answers wrongly. The cap has to sit well above
    // the case the ladder actually depends on.
    const addresses = Array.from({ length: 40 }, (_, i) => `address ${i}`);
    const view = toEntityView(entity({ addresses }));

    expect(view.addresses).toHaveLength(25);
    expect(view.addresses[11]).toBe('address 11');
    expect(view.addressCount).toBe(40);
    expect(view.omitted.join(' ')).toContain('15 further address');
  });

  it('says nothing was omitted when nothing was', () => {
    expect(toEntityView(entity({ addresses: ['one'] })).omitted).toEqual([]);
  });

  it('replaces relationship rows with counts by type, and says it did', () => {
    const view = toEntityView(
      entity({
        relationship_count: { carrier_of: 88_221, receives_from: 70 },
        relationships: { data: [{ x: 1 }, { x: 2 }] } as never,
      }),
    );

    expect(view.relationshipCount).toEqual({ carrier_of: 88_221, receives_from: 70 });
    expect(view).not.toHaveProperty('relationships');
    // The rows are gone, so the payload has to name the tool that has them.
    expect(view.omitted.join(' ')).toContain('get_supplier_network');
  });

  it('carries each risk factor with its level and traversal path', () => {
    const view = toEntityView(
      entity({
        risk: {
          exports_bis_high_priority_items_indirect: {
            level: 'elevated',
            metadata: { traversal_path: ['a|shipper_of|b'] },
          },
        } as never,
      }),
    );

    expect(view.risk).toEqual([
      {
        factor: 'exports_bis_high_priority_items_indirect',
        level: 'elevated',
        traversalPath: ['a|shipper_of|b'],
      },
    ]);
    expect(view.riskFactorCount).toBe(1);
  });

  it('reports a null traversal path rather than an object it cannot use', () => {
    // The metadata shape varies by factor — a country-derived one carries
    // `{ country: [...] }` and no path at all.
    const view = toEntityView(
      entity({
        risk: { cpi_score: { level: 'relevant', metadata: { country: ['NGA'] } } } as never,
      }),
    );
    expect(view.risk[0]!.traversalPath).toBeNull();
  });
});

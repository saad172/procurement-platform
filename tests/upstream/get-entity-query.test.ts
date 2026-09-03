import { describe, expect, it } from 'vitest';
import { getEntityQuery } from '@/upstream/endpoints';

/**
 * `getEntity`'s raw-fallback query string (ticket 01 item B; BUILD-NOTES 31).
 *
 * Before this ticket the raw fallback sent the path alone, dropping all
 * eleven limit params and every `relationships*` filter — a caller falling
 * back to the raw path silently got the server's unfiltered default instead
 * of an error. This is the table test the item calls for: every camelCase
 * param produces the SDK's own wire key (copied from `node_modules/@sayari/
 * sdk/api/resources/entity/client/Client.js`), and an absent param is
 * omitted rather than sent as `"undefined"`.
 */
describe('getEntityQuery (SPEC §16.6; BUILD-NOTES 31)', () => {
  it('omits every key when nothing is set', () => {
    const query = getEntityQuery({});
    for (const value of Object.values(query)) expect(value).toBeUndefined();
  });

  it.each([
    ['attributesAdditionalInformationLimit', 5, 'attributes.additional_information.limit'],
    ['attributesAddressLimit', 100, 'attributes.address.limit'],
    ['attributesBusinessPurposeLimit', 100, 'attributes.business_purpose.limit'],
    ['attributesCompanyTypeLimit', 5, 'attributes.company_type.limit'],
    ['attributesCountryLimit', 100, 'attributes.country.limit'],
    ['attributesIdentifierLimit', 100, 'attributes.identifier.limit'],
    ['attributesNameLimit', 100, 'attributes.name.limit'],
    ['attributesStatusLimit', 100, 'attributes.status.limit'],
    ['relationshipsLimit', 100, 'relationships.limit'],
    ['relationshipsType', 'shareholder_of', 'relationships.type'],
    ['relationshipsSort', '-shares', 'relationships.sort'],
    ['relationshipsStartDate', '2020-01-01', 'relationships.startDate'],
    ['relationshipsEndDate', '2024-01-01', 'relationships.endDate'],
    ['relationshipsMinShares', 25, 'relationships.minShares'],
    ['relationshipsArrivalState', 'CA', 'relationships.arrivalState'],
    ['relationshipsArrivalCity', 'Los Angeles', 'relationships.arrivalCity'],
    ['relationshipsDepartureState', 'NY', 'relationships.departureState'],
    ['relationshipsDepartureCity', 'New York', 'relationships.departureCity'],
    ['relationshipsPartnerName', 'Acme', 'relationships.partnerName'],
    ['relationshipsHsCode', '870899', 'relationships.hsCode'],
    ['possiblySameAsLimit', 100, 'possibly_same_as.limit'],
    ['referencedByLimit', 20, 'referenced_by.limit'],
  ] as const)('maps %s to %s', (camel, value, wireKey) => {
    const query = getEntityQuery({ [camel]: value });
    expect(query[wireKey as keyof typeof query]).toBe(value);
    // Every other key stays undefined — one param in, one param out.
    for (const [key, v] of Object.entries(query)) {
      if (key !== wireKey) expect(v, key).toBeUndefined();
    }
  });

  it('carries the array-valued relationships filters as arrays (repeat encoding)', () => {
    const query = getEntityQuery({
      relationshipsCountry: ['USA', 'MEX'],
      relationshipsArrivalCountry: ['USA'],
      relationshipsDepartureCountry: ['CHN', 'JPN'],
      relationshipsPartnerRisk: ['sanctioned'],
    });
    expect(query['relationships.country']).toEqual(['USA', 'MEX']);
    expect(query['relationships.arrivalCountry']).toEqual(['USA']);
    expect(query['relationships.departureCountry']).toEqual(['CHN', 'JPN']);
    expect(query['relationships.partnerRisk']).toEqual(['sanctioned']);
  });

  it('also accepts the same relationships filters as bare scalars', () => {
    const query = getEntityQuery({ relationshipsCountry: 'USA' });
    expect(query['relationships.country']).toBe('USA');
  });
});

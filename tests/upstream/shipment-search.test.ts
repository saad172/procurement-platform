import { describe, expect, it } from 'vitest';
import { shipmentSearchSchema, shipmentSchema } from '@/upstream/projections/sayari';

/**
 * `shipmentSearchSchema`/`shipmentSchema` (network spec §4.3, ticket 05) —
 * `trade.searchShipments`'s response. A hand-built body shaped like the
 * SDK's own documented example
 * (`node_modules/@sayari/sdk/api/resources/trade/types/
 * ShipmentSearchResponse.d.ts`), camelCase, as the SDK path deserialises it —
 * matching ticket 04's `shortestPathSchema` test style
 * (`tests/upstream/shortest-path.test.ts`) for a projection with no live
 * fixture recorded yet.
 */
describe('shipmentSearchSchema / shipmentSchema', () => {
  const sdkBody = {
    offset: 0,
    limit: 1,
    size: { count: 13, qualifier: 'eq' },
    next: true,
    data: [
      {
        id: 'Sdl3aYnJ23Y-3IxgIOkXPA',
        type: 'shipment',
        buyer: [
          {
            id: 'uWNWgzX-Kvp1j-WeXKmLQw',
            type: 'receiver_of',
            names: ['ERBE ELECTROMEDICAL LLC'],
            risks: { imports_bis_high_priority_items: 1 },
            countries: ['RUS'],
          },
        ],
        supplier: [
          {
            id: 'yNwunHdFInERKig0Thusgg',
            type: 'shipper_of',
            names: ['ERBE ELEKTROMEDIZIN GMBH'],
            risks: { exports_bis_high_priority_items_critical_components_direct: 1 },
            countries: ['DEU'],
          },
        ],
        arrivalDate: ['2024-01-30'],
        departureDate: ['2022-05'],
        arrivalCountry: [],
        departureCountry: ['USA'],
        transitCountry: [],
        countries: ['DEU', 'RUS'],
        productOrigin: ['DEU'],
        monetaryValue: [{ value: 2570.52, currency: 'usd', context: 'cost_insurance_and_freight' }],
        weight: [{ value: 5.5, unit: 'kilogram', type: 'net_weight' }],
        identifier: [{ value: '10013160/140524/3162513', type: 'rus_declaration_number' }],
        sources: [{ id: '66dfefb726ae00fde8f09f34c5578d35', label: 'Russia Imports & Exports' }],
        hsCodes: [{ code: '854231', description: 'Electronic integrated circuits', imputed: false }],
        productDescriptions: ['INTEGRATED CIRCUITS'],
        record: '4337bf42a200a30b90d536c5992167e1/1001325059/1721001600000/0',
      },
    ],
  };

  it('projects the envelope', () => {
    const parsed = shipmentSearchSchema.parse(sdkBody);
    expect(parsed.size?.count).toBe(13);
    expect(parsed.next).toBe(true);
    expect(parsed.data).toHaveLength(1);
  });

  it('projects one shipment row: buyer, product origin, value, weight, record', () => {
    const parsed = shipmentSearchSchema.parse(sdkBody);
    const row = parsed.data![0]!;
    expect(row.id).toBe('Sdl3aYnJ23Y-3IxgIOkXPA');
    expect(row.buyer?.[0]?.id).toBe('uWNWgzX-Kvp1j-WeXKmLQw');
    expect(row.buyer?.[0]?.countries).toEqual(['RUS']);
    expect(row.product_origin).toEqual(['DEU']);
    expect(row.monetary_value?.[0]?.value).toBe(2570.52);
    expect(row.weight?.[0]?.value).toBe(5.5);
    expect(row.hs_codes?.[0]?.code).toBe('854231');
    // The citation target (SPEC §10.2) — required and singular.
    expect(row.record).toBe('4337bf42a200a30b90d536c5992167e1/1001325059/1721001600000/0');
  });

  it('projects arrival_date/departure_date as the SDK\'s own arrays, not one picked value', () => {
    const parsed = shipmentSearchSchema.parse(sdkBody);
    const row = parsed.data![0]!;
    expect(row.arrival_date).toEqual(['2024-01-30']);
    expect(row.departure_date).toEqual(['2022-05']);
  });

  it('parses a single shipment row directly through shipmentSchema', () => {
    const row = shipmentSchema.parse(sdkBody.data[0]);
    expect(row.id).toBe('Sdl3aYnJ23Y-3IxgIOkXPA');
    expect(row.record).toBeTruthy();
  });

  it('accepts an empty result page', () => {
    const parsed = shipmentSearchSchema.parse({ offset: 0, limit: 50, size: { count: 0 }, next: false, data: [] });
    expect(parsed.data).toEqual([]);
  });

  it('also accepts the raw-fetch fallback\'s snake_case shape unchanged (eitherCasing)', () => {
    const snakeBody = {
      offset: 0,
      limit: 1,
      size: { count: 1, qualifier: 'eq' },
      next: false,
      data: [
        {
          id: 'shipment-1',
          buyer: [{ id: 'buyer-1', countries: ['RUS'] }],
          product_origin: ['DEU'],
          monetary_value: [{ value: 100, currency: 'usd' }],
          weight: [{ value: 1, unit: 'kilogram', type: 'net_weight' }],
          record: 'source/ref/12345/0',
        },
      ],
    };
    const parsed = shipmentSearchSchema.parse(snakeBody);
    expect(parsed.data?.[0]?.product_origin).toEqual(['DEU']);
    expect(parsed.data?.[0]?.record).toBe('source/ref/12345/0');
  });
});

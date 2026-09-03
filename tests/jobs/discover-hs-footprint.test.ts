import { describe, expect, it } from 'vitest';
import { hsCodesOf } from '@/jobs/discover';
import type { SayariTradeRow } from '@/upstream/projections/sayari';

/**
 * **A Lead's HS footprint is the row's** (ticket 01 item C, CONTEXT.md
 * *Discover*, SPEC §11). `discover.ts` used to write the Category's queried
 * lines onto every Lead it proposed, which said nothing about what that
 * particular company actually shipped.
 *
 * The row below is shaped like `tradeMetadataSchema`
 * (`src/upstream/projections/sayari.ts`) — `key` the six-digit line, `value`
 * and `doc_count` alongside it — rather than a recorded body, since no trade
 * search fixture is checked in (hard rule: no live calls, and nothing has
 * ever recorded one).
 */

const row = (hsCodes: SayariTradeRow['metadata']['hs_codes']): SayariTradeRow =>
  ({
    id: 'test-entity',
    label: 'TEST TRADE ROW LLC',
    metadata: { shipments: 12, hs_codes: hsCodes },
  }) as never;

describe('hsCodesOf reads the ROW’s own metadata.hs_codes, never the query', () => {
  it('reads the six-digit keys off the row', () => {
    expect(
      hsCodesOf(
        row([
          { key: '854430', value: 'Ignition wiring sets', doc_count: 40 },
          { key: '854442', value: 'Other electric conductors', doc_count: 3 },
        ]),
      ),
    ).toEqual(['854430', '854442']);
  });

  it('dedupes repeated keys', () => {
    expect(
      hsCodesOf(
        row([
          { key: '854430', value: 'a', doc_count: 1 },
          { key: '854430', value: 'b', doc_count: 2 },
        ]),
      ),
    ).toEqual(['854430']);
  });

  it('drops a null or missing key rather than writing a blank line', () => {
    expect(hsCodesOf(row([{ key: null, value: 'x', doc_count: 1 }]))).toEqual([]);
    expect(hsCodesOf(row([{ value: 'x', doc_count: 1 }]))).toEqual([]);
  });

  it('is empty when the row states none — never backfilled from the query', () => {
    expect(hsCodesOf(row(null))).toEqual([]);
    expect(hsCodesOf(row(undefined))).toEqual([]);
    expect(hsCodesOf({ id: 'x', label: 'X', metadata: { shipments: 1 } } as never)).toEqual([]);
  });
});

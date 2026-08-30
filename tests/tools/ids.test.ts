import { describe, expect, it } from 'vitest';
import { isDatabaseId, notAnIdObjection } from '@/tools/ids';

/**
 * A resolve Round called `get_supplier` with `{ supplierId: "Yazaki" }` — the
 * roster name, which is the first thing the prompt shows it, so reaching for it
 * is the natural mistake rather than a careless one.
 *
 * Postgres answered `invalid input syntax for type uuid`, which threw out of
 * the handler: the model was told a database error instead of what to do, and
 * the throw skipped the Trace row entirely.
 */
describe('isDatabaseId', () => {
  it('accepts a uuid, in either case', () => {
    expect(isDatabaseId('ba97b16c-4b1a-5ba6-b2ba-3403874ac2ca')).toBe(true);
    expect(isDatabaseId('BA97B16C-4B1A-5BA6-B2BA-3403874AC2CA')).toBe(true);
  });

  it('rejects the roster name that caused this', () => {
    expect(isDatabaseId('Yazaki')).toBe(false);
  });

  it('rejects a Sayari entity id, which is not a uuid', () => {
    // Sayari ids are 22-character base64url. Accepting one here would let a
    // supplier lookup be attempted with an entity id and fail deeper down.
    expect(isDatabaseId('CX3012yTGIhgMxcZG6hgnA')).toBe(false);
  });

  it('rejects a uuid with the wrong shape', () => {
    expect(isDatabaseId('ba97b16c4b1a5ba6b2ba3403874ac2ca')).toBe(false);
    expect(isDatabaseId('ba97b16c-4b1a-5ba6-b2ba-3403874ac2c')).toBe(false);
  });
});

describe('notAnIdObjection', () => {
  it('names the value and the tool that finds a real one', () => {
    // Without the next step, "that is not a valid id" is a dead end the model
    // can only guess its way out of.
    const objection = notAnIdObjection('supplier id', 'Yazaki', 'find_supplier_by_name');
    expect(objection).toContain('Yazaki');
    expect(objection).toContain('find_supplier_by_name');
  });
});

import { describe, expect, it } from 'vitest';
import { toEntityView } from '@/domain/entity-view';

/**
 * **Two representations of one company, and they are not interchangeable.**
 *
 * `toEntityView` projects a **Sayari** entity — `countries`, `addresses`,
 * `identifiers`, `source_count` as an object keyed by source hash. The **local**
 * `entity` table stores the same company as `country`, `address_line`, `lei`
 * and a separate `distinct_source_count`.
 *
 * `get_supplier` fed the second to the first. Every field read `undefined`, and
 * the model was handed a company with no country, no address and no
 * identifiers. It reported exactly that in a published Assessment — *"the
 * entity snapshot carried on the match itself is thin"* — and then found the
 * real row through another tool. The prose was accurate about what it had been
 * shown; what it had been shown was wrong.
 *
 * This test does not stop the mistake — `as never` will always compile. It
 * makes the *shape difference* explicit, so the next reader meets it as a
 * stated fact rather than discovering it in an Assessment.
 */
describe('toEntityView takes a Sayari projection, not a local row', () => {
  it('reads the Sayari shape', () => {
    const view = toEntityView({
      id: 'CX3012yTGIhgMxcZG6hgnA',
      label: 'YAZAKI CORPORATION',
      countries: ['JPN'],
      addresses: ['1-8-15, KONAN'],
      source_count: { a: 1, b: 2 },
    } as never);

    expect(view.country).toBe('JPN');
    expect(view.addresses).toEqual(['1-8-15, KONAN']);
    expect(view.sourceCount).toBe(2);
  });

  it('reads nothing at all from a local entity row', () => {
    // The exact failure, pinned: same company, local column names, and the
    // projection sees an empty husk.
    const view = toEntityView({
      id: 'CX3012yTGIhgMxcZG6hgnA',
      label: 'YAZAKI CORPORATION',
      country: 'JPN',
      addressLine: '1-8-15, KONAN',
      lei: '35380087YNQB9R822X46',
      distinctSourceCount: 13,
    } as never);

    expect(view.country).toBeNull();
    expect(view.addresses).toEqual([]);
    expect(view.identifiers).toEqual([]);
    expect(view.sourceCount).toBe(0);
  });
});

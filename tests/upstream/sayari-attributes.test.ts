import { describe, expect, it } from 'vitest';
import { entitySchema, attributeText, attributeTexts } from '@/upstream/projections/sayari';
import { toCandidateFacts } from '@/jobs/resolve';

/**
 * **An attribute entry keeps its value in `properties.value`. It has no
 * top-level `value` at all.**
 *
 * Measured against the whole local corpus of 313 `entity.getEntity` bodies, by
 * counting the keys of every attribute entry of every type:
 *
 * ```
 * businessPurpose  2078 entries — properties, record, sources, editable, recordCount
 * identifier       3224 entries — the same five
 * country          3112 entries — the same five
 * name             1857 entries — the same five
 * address          1827 entries — the same five
 * companyType       779 entries — the same five
 * status            609 entries — the same five
 * ```
 *
 * **Zero of them carry `value`.** So the projection's own top-level `value`
 * field was a phantom: it never matched anything, and because the projection is
 * lenient by design it read `undefined` without ever failing. That is the same
 * failure mode `key-case.ts` warns about, one level further down — a shape
 * mismatch reading as absent data rather than as an error.
 *
 * What it cost, both confirmed in the database before this was fixed:
 *
 * - `businessPurposes` was always `[]`, so the `business_purpose`
 *   Discriminator judged an empty input and passed **353 of 362 candidates —
 *   97.5%**, the pass rate BUILD-NOTES recorded as an unexplained puzzle.
 * - `aliases` was always `[]`, so `alias_context` **failed 64 candidates, and
 *   all 64 stored reasoning lines read "nor any of its 0 aliases"**. The check
 *   had never once had data to work with. One of the 64 is a Cyrillic legal
 *   name whose roster name exists only in the transliterated alias.
 *
 * The second half of the same bug: `properties` was typed as a **closed**
 * object listing only the address fields, so Zod stripped `value`, `code` and
 * `standard` from every non-address attribute. Fixing the reader without
 * opening the shape would have changed nothing.
 */

/** One attribute entry, in the shape the API actually returns. */
function entry(properties: Record<string, unknown>) {
  return {
    record: ['ddbf93a5c5d568ccdb0c2455f7ecbfc8/6529/1583271290282'],
    sources: ['ddbf93a5c5d568ccdb0c2455f7ecbfc8'],
    editable: false,
    recordCount: 15,
    properties,
  };
}

/**
 * A camelCase body, as the SDK path deserialises it — which is what every one
 * of the 313 stored bodies is.
 */
const sdkBody = {
  id: 'gC94jqVAt4yW_Ur9IBKLAA',
  label: 'Открытое акционерное общество «Рособоронэкспорт»',
  companyType: 'CORP',
  registrationDate: '1987-01-13',
  psaCount: 676,
  tradeCount: { sent: 14517, received: 50241 },
  sourceCount: { abc: {}, def: {} },
  relationshipCount: { has_shareholder: 4 },
  possiblySameAs: { data: [{ id: 'other' }], next: null },
  attributes: {
    businessPurpose: {
      data: [
        entry({
          code: '2910',
          value: 'Manufacture of motor vehicles',
          standard: 'ISIC4',
          'Original Code Before Sayari Conversion to ISIC4': '3714 (SIC)',
        }),
        entry({ value: 'Wholesale of car parts', standard: 'ISIC4' }),
      ],
    },
    name: {
      data: [
        entry({ value: 'Rosoboronexport', context: 'transliterated' }),
        entry({ value: 'ROE JSC' }),
      ],
    },
    address: {
      data: [
        entry({
          value: '27 Stromynka St, Moscow',
          city: 'Moscow',
          postcode: '107076',
          country: 'RUS',
          houseNumber: '27',
          road: 'Stromynka',
          x: 37.7,
          y: 55.8,
        }),
      ],
    },
  },
} as const;

describe('the Sayari entity projection, over a body shaped like the real ones', () => {
  /**
   * Pinned deliberately. A previous pass read the *stored* bodies, found no
   * snake_case keys in them, and concluded the projection was silently
   * yielding null for twenty fields. The cache is verbatim on purpose
   * (`key-case.ts`) and normalisation happens here, at projection time — so
   * the only way to see what the projection produces is to run it. This test
   * is that check, standing, so the false alarm cannot be raised twice.
   */
  it('normalises camelCase from the SDK path into the snake_case every caller reads', () => {
    const parsed = entitySchema.parse(sdkBody);
    expect(parsed).toMatchObject({
      company_type: 'CORP',
      registration_date: '1987-01-13',
      psa_count: 676,
      trade_count: { sent: 14517, received: 50241 },
    });
    expect(Object.keys(parsed.source_count ?? {})).toHaveLength(2);
    expect(parsed.possibly_same_as?.data).toHaveLength(1);
    // The record keys of `attributes` are normalised too, which is what makes
    // `attributes.business_purpose` the name the rest of the app can use.
    expect(Object.keys(parsed.attributes ?? {})).toContain('business_purpose');
  });

  it('keeps the property keys that are not address fields', () => {
    const parsed = entitySchema.parse(sdkBody);
    const first = parsed.attributes?.business_purpose?.data?.[0];
    expect(first?.properties).toMatchObject({
      value: 'Manufacture of motor vehicles',
      code: '2910',
      standard: 'ISIC4',
    });
  });

  it('still types the structured address fields it geocodes from', () => {
    const parsed = entitySchema.parse(sdkBody);
    const address = parsed.attributes?.address?.data?.[0];
    // `houseNumber` arrives camelCase and is read as `house_number`.
    expect(address?.properties).toMatchObject({
      city: 'Moscow',
      postcode: '107076',
      country: 'RUS',
      house_number: '27',
      x: 37.7,
      y: 55.8,
    });
  });

  it('reads an attribute value from where it lives, not from the phantom field', () => {
    const parsed = entitySchema.parse(sdkBody);
    const purposes = parsed.attributes?.business_purpose?.data ?? [];
    expect(attributeText(purposes[0])).toBe('Manufacture of motor vehicles');
    expect(attributeTexts(purposes)).toEqual([
      'Manufacture of motor vehicles',
      'Wholesale of car parts',
    ]);
  });

  it('reads nothing from an entry that genuinely has no value', () => {
    expect(attributeText(entry({ code: '2910' }))).toBeNull();
    expect(attributeText(undefined)).toBeNull();
    expect(attributeTexts([entry({ code: '2910' }), entry({ value: 'ok' })])).toEqual(['ok']);
  });
});

describe('the facts a Discriminator is given', () => {
  it('carries the business purposes that decide business_purpose', () => {
    const facts = toCandidateFacts(entitySchema.parse(sdkBody));
    expect(facts.businessPurposes).toEqual([
      'Manufacture of motor vehicles',
      'Wholesale of car parts',
    ]);
  });

  /**
   * The 64-failure case. The roster name "Rosoboronexport" is nowhere in the
   * Cyrillic legal name; it exists only as a transliterated alias, which is
   * exactly the evidence `alias_context` is there to weigh.
   */
  it('carries the aliases that decide alias_context', () => {
    const facts = toCandidateFacts(entitySchema.parse(sdkBody));
    expect(facts.aliases).toEqual(['Rosoboronexport', 'ROE JSC']);
  });

  it('still reads the address blocks it always read, now with the line the street rung needs', () => {
    const facts = toCandidateFacts(entitySchema.parse(sdkBody));
    expect(facts.addresses).toEqual([
      { city: 'Moscow', postcode: '107076', country: 'RUS', line: '27 Stromynka St, Moscow' },
    ]);
    expect(facts.country).toBe('RUS');
    expect(facts.companyType).toBe('CORP');
  });
});

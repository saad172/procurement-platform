import { describe, expect, it } from 'vitest';
import { describeSupplier } from '@/domain/supplier-description';
import { entitySchema, type SayariEntity } from '@/upstream/projections/sayari';

/**
 * **Every fact in this description has been stored against the company since
 * the first enrichment ran, and none of it reached a page** — the attribute
 * projection dropped it (BUILD-NOTES finding 90), so `businessPurposes` was
 * always `[]` and there was nothing to write from.
 *
 * The hard part is not reading the field, it is that a record files the same
 * activity **once per country under its own national scheme**. Bosch's carries
 * 32 entries across ISIC4, NAF2, CNAE2, NACE2, ATECO and NAF1993, in French,
 * Portuguese and Italian. Ranked naively, the head of an English page reads
 * *Fabrication d'équipements électriques et électroniques automobiles*.
 */

/** An attribute entry in the shape the API actually returns. */
const purpose = (value: string, code: string, standard: string, recordCount: number) => ({
  record: ['r'],
  sources: ['s'],
  editable: false,
  recordCount,
  properties: { value, code, standard },
});

const entity = (attributes: Record<string, unknown>, rest: Record<string, unknown> = {}) =>
  entitySchema.parse({ id: 'e1', label: 'ROBERT BOSCH GMBH', attributes, ...rest }) as SayariEntity;

describe('the description a manager reads first', () => {
  /**
   * The measured case: Bosch files *parts and accessories for motor vehicles*
   * under four schemes across five countries, 53 records between them, while
   * the activities named once are the tail. **The codes disagree on detail and
   * agree on the main point**, and the number of records behind each is what
   * that agreement looks like.
   */
  it('leads with the activity the most records assert, in the converted standard', () => {
    const described = describeSupplier(
      entity({
        businessPurpose: {
          data: [
            purpose("Fabrication d'équipements électriques automobiles", '29.31Z', 'NAF2', 26),
            purpose('Manufacture of parts and accessories for motor vehicles', '2930', 'ISIC4', 22),
            purpose('Fabricação de peças e acessórios', '29.41-7', 'CNAE2', 19),
            purpose('Manufacture of parts and accessories for motor vehicles', '2930', 'ISIC4', 19),
            purpose('Manufacture of other electrical equipment', '2790', 'ISIC4', 1),
          ],
        },
      }),
    );
    expect(described.headline).toBe(
      'Manufacture of parts and accessories for motor vehicles and manufacture of other electrical equipment.',
    );
  });

  /**
   * The three separate ISIC4 `2930` entries a multi-country record carries are
   * one activity with 53 records, not three with 22, 19 and 12 — which is the
   * difference between it leading and it placing fourth.
   */
  it('adds up the records behind one activity rather than counting it three times', () => {
    const described = describeSupplier(
      entity({
        businessPurpose: {
          data: [
            purpose('Manufacture of other general-purpose machinery', '2819', 'ISIC4', 30),
            purpose('Manufacture of parts and accessories for motor vehicles', '2930', 'ISIC4', 22),
            purpose('Manufacture of parts and accessories for motor vehicles', '2930', 'ISIC4', 19),
            purpose('Manufacture of parts and accessories for motor vehicles', '2930', 'ISIC4', 12),
          ],
        },
      }),
    );
    // 22 + 19 + 12 = 53 beats the 30 that would otherwise lead.
    expect(described.headline).toBe(
      'Manufacture of parts and accessories for motor vehicles and manufacture of other general-purpose machinery.',
    );
  });

  /**
   * A catch-all says "classified nowhere else", which describes nothing. It is
   * kept — dropping evidence is how this came to be empty in the first place —
   * and simply never leads.
   */
  it('never leads with a catch-all, however many records assert it', () => {
    const described = describeSupplier(
      entity({
        businessPurpose: {
          data: [
            purpose('Other business support service activities n.e.c.', '8299', 'ISIC4', 99),
            purpose('Manufacture of other electrical equipment', '2790', 'ISIC4', 1),
          ],
        },
      }),
    );
    expect(described.headline).toBe(
      'Manufacture of other electrical equipment and other business support service activities n.e.c..',
    );
  });

  /** A record filed under no ISIC line still has to be describable. */
  it('falls back to the national labels when nothing was converted', () => {
    const described = describeSupplier(
      entity({
        businessPurpose: {
          data: [purpose('Commercio di parti di autoveicoli', '453101', 'ATECO', 10)],
        },
      }),
    );
    expect(described.headline).toBe('Commercio di parti di autoveicoli.');
  });

  it('says nothing rather than something empty when the record states no purpose', () => {
    // Aptiv, in the real roster: an accepted match whose record carries no
    // business purpose at all. An empty sentence would read as a finding.
    expect(describeSupplier(entity({})).headline).toBeNull();
  });
});

describe('the figures beside it', () => {
  it('counts the address ATTRIBUTE, not the summary list', () => {
    // Bosch carries 91 addresses in the attribute against 3 in `addresses[]`.
    const described = describeSupplier(
      entity(
        { address: { data: Array.from({ length: 91 }, () => ({ properties: { value: 'a' } })) } },
        { addresses: ['one', 'two', 'three'] },
      ),
    );
    expect(described.figures).toContainEqual({ value: '91', label: 'addresses on record' });
  });

  /**
   * A maker sends far more than it receives, which is exactly the distinction a
   * buyer is checking for — so the two are kept apart rather than summed.
   */
  it('reports shipments sent, compactly, and keeps received separate', () => {
    const described = describeSupplier(
      entity({}, { tradeCount: { sent: 1141941, received: 254381 } }),
    );
    expect(described.figures).toContainEqual({ value: '1.14m', label: 'shipments sent' });
    expect(described.trade).toEqual({ sent: 1141941, received: 254381 });
  });

  it('leaves out a figure the record does not carry', () => {
    const described = describeSupplier(entity({}));
    expect(described.figures).toEqual([]);
    expect(described.trade).toBeNull();
  });

  it('counts one country as one country', () => {
    const described = describeSupplier(entity({}, { countries: ['USA'] }));
    expect(described.figures).toContainEqual({ value: '1', label: 'country it operates in' });
  });

  it('takes the year from the registration date and the legal form as filed', () => {
    const described = describeSupplier(
      entity({}, { registrationDate: '1886-11-15', companyType: 'GmbH' }),
    );
    expect(described.figures.slice(0, 2)).toEqual([
      { value: '1886', label: 'registered since' },
      { value: 'GmbH', label: 'legal form' },
    ]);
  });
});

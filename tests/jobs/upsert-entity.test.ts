import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upsertEntity } from '@/jobs/resolve';
import type { SayariEntity } from '@/upstream/projections/sayari';
import {
  START_TEST_DB_HINT,
  closeTestDb,
  getTestDb,
  testDatabaseIsUp,
  testSql,
} from '../support/test-db';

/**
 * **An entity is written from many sightings, and most of them are partial.**
 *
 * Only 313 of the 14,816 entities in the local database were ever fetched with
 * a `getEntity` call of their own. The rest arrived nested — as a traversal
 * terminal, a trade row, a search hit — and a nested sighting carries whatever
 * that endpoint chose to include. A traversal target carries its full `risk`
 * block inline but no `psaCount`; a search hit carries neither.
 *
 * So `upsertEntity` is called repeatedly for the same id with bodies of
 * different completeness, in no guaranteed order, and both directions of that
 * used to lose data:
 *
 * - **Blanking.** `psaCount`, `relationshipCount` and `risk` were written
 *   unconditionally in the conflict branch, so a later partial sighting
 *   overwrote a good value with null. **73 entities held `psaCount` — values 0
 *   through 21 — and `relationshipCount` in their own stored payload while the
 *   row said null.**
 * - **Stranding.** Everything else was written only on insert, so a first
 *   partial sighting left a column null for ever, even after the entity's own
 *   full payload arrived. **11 entities had `sourceCount` stranded that way.**
 *
 * `upstreamResponseId` was already guarded against the first of these, with a
 * note explaining exactly why. The fix generalises that note to every column:
 * on conflict, a column moves only when the incoming sighting actually has a
 * value for it.
 */

const up = await testDatabaseIsUp();

describe.skipIf(!up)(`upsertEntity across partial sightings (needs: ${START_TEST_DB_HINT})`, () => {
  const ID = 'upsert-fixture-entity';

  /** The entity's own `getEntity` body: everything present. */
  const full: SayariEntity = {
    id: ID,
    label: 'ROBERT BOSCH GMBH',
    type: 'company',
    countries: ['DEU'],
    addresses: ['Robert-Bosch-Platz 1, Gerlingen'],
    sanctioned: false,
    pep: false,
    closed: false,
    psa_count: 676,
    source_count: { a: {}, b: {} },
    relationship_count: { has_shareholder: 4 },
    risk: { basel_aml: { level: 'relevant' } },
    identifiers: [{ type: 'lei', value: '335800R33O65CZHL6217' }],
    attributes: {
      address: {
        data: [
          {
            properties: {
              value: 'Robert-Bosch-Platz 1',
              city: 'Gerlingen',
              postcode: '70839',
              country: 'DEU',
              x: 9.06,
              y: 48.8,
            },
          },
        ],
      },
    },
  } as SayariEntity;

  /**
   * The same entity seen inside somebody else's traversal: a label, a risk
   * block, and nothing else. This is the shape that used to do the damage.
   */
  const nested: SayariEntity = {
    id: ID,
    label: 'ROBERT BOSCH GMBH',
    risk: { cpi_score: { level: 'relevant' } },
  } as SayariEntity;

  const read = async () => {
    const [row] = await testSql()`SELECT * FROM entity WHERE id = ${ID}`;
    return row as Record<string, unknown> | undefined;
  };

  beforeAll(async () => {
    await getTestDb();
  });

  afterAll(async () => {
    if (!up) return;
    await testSql()`DELETE FROM entity WHERE id = ${ID}`;
    await closeTestDb();
  });

  it('writes what a full payload carries', async () => {
    const db = await getTestDb();
    await testSql()`DELETE FROM entity WHERE id = ${ID}`;
    await upsertEntity(db, full);

    expect(await read()).toMatchObject({
      label: 'ROBERT BOSCH GMBH',
      country: 'DEU',
      city: 'Gerlingen',
      postcode: '70839',
      psa_count: 676,
      distinct_source_count: 2,
      lei: '335800R33O65CZHL6217',
    });
  });

  /** The 73-entity case. */
  it('does not let a later partial sighting blank what a full one established', async () => {
    const db = await getTestDb();
    await testSql()`DELETE FROM entity WHERE id = ${ID}`;
    await upsertEntity(db, full);
    await upsertEntity(db, nested);

    const row = await read();
    expect(row).toMatchObject({
      psa_count: 676,
      country: 'DEU',
      city: 'Gerlingen',
      lei: '335800R33O65CZHL6217',
      distinct_source_count: 2,
    });
    expect(row?.relationship_count).toEqual({ has_shareholder: 4 });
    // The newer risk block is genuinely newer evidence, so it does move.
    expect(row?.risk).toEqual({ cpi_score: { level: 'relevant' } });
  });

  /** The 11-entity case: the same bug with the sightings the other way round. */
  it('fills in what a first partial sighting left empty', async () => {
    const db = await getTestDb();
    await testSql()`DELETE FROM entity WHERE id = ${ID}`;
    await upsertEntity(db, nested);

    expect(await read()).toMatchObject({ psa_count: null, country: null, lei: null });

    await upsertEntity(db, full);
    const row = await read();
    expect(row).toMatchObject({
      psa_count: 676,
      country: 'DEU',
      city: 'Gerlingen',
      postcode: '70839',
      lei: '335800R33O65CZHL6217',
      distinct_source_count: 2,
      entity_type: 'company',
    });
    expect(row?.relationship_count).toEqual({ has_shareholder: 4 });
  });

  /**
   * `false` is a value, not an absence. Booleans default to `false` in the
   * column, so a coalesce written with `??` on the projected side would be
   * correct while one written against the stored `false` would not — this
   * pins that a real `false` still lands.
   */
  it('treats a sighting that says false as having said something', async () => {
    const db = await getTestDb();
    await testSql()`DELETE FROM entity WHERE id = ${ID}`;
    await upsertEntity(db, { ...full, sanctioned: true, closed: true } as SayariEntity);
    expect(await read()).toMatchObject({ sanctioned: true, closed: true });

    await upsertEntity(db, { ...full, sanctioned: false, closed: false } as SayariEntity);
    expect(await read()).toMatchObject({ sanctioned: false, closed: false });
  });

  /**
   * The guard that was already there, kept: a nested sighting carries no body
   * of this entity's own, so letting it write null would erase the provenance
   * a direct fetch had recorded — and the Profile page's provenance line reads
   * this column.
   */
  it('keeps the provenance link a direct fetch established', async () => {
    const db = await getTestDb();
    await testSql()`DELETE FROM entity WHERE id = ${ID}`;
    const [payload] = await testSql()`
      INSERT INTO upstream_response (source, endpoint, params_hash, params, body, body_hash, via)
      VALUES ('sayari', 'entity.getEntity', 'h', '{}'::jsonb, '{}'::jsonb, 'bh', 'sdk')
      RETURNING id`;

    await upsertEntity(db, full, payload!.id as string);
    expect((await read())?.upstream_response_id).toBe(payload!.id);

    await upsertEntity(db, nested);
    expect((await read())?.upstream_response_id).toBe(payload!.id);

    await testSql()`DELETE FROM entity WHERE id = ${ID}`;
    await testSql()`DELETE FROM upstream_response WHERE id = ${payload!.id as string}`;
  });

  /**
   * `firstSeenAt` is deliberately never re-stamped: the *new evidence*
   * staleness chip is computed from it, and re-stamping would silence the
   * signal.
   */
  it('leaves first_seen_at alone while moving fetched_at', async () => {
    const db = await getTestDb();
    await testSql()`DELETE FROM entity WHERE id = ${ID}`;
    await upsertEntity(db, full);
    const before = await read();

    await new Promise((resolve) => setTimeout(resolve, 5));
    await upsertEntity(db, nested);
    const after = await read();

    expect(after?.first_seen_at).toEqual(before?.first_seen_at);
    expect(new Date(after?.fetched_at as string).getTime()).toBeGreaterThan(
      new Date(before?.fetched_at as string).getTime(),
    );
  });
});

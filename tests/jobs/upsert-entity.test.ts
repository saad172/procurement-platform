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
    await upsertEntity(db, full, undefined, 'getEntity');

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
    await upsertEntity(db, full, undefined, 'getEntity');
    await upsertEntity(db, nested, undefined, 'getEntity');

    const row = await read();
    expect(row).toMatchObject({
      psa_count: 676,
      country: 'DEU',
      city: 'Gerlingen',
      lei: '335800R33O65CZHL6217',
      distinct_source_count: 2,
    });
    expect(row?.relationship_count).toEqual({ has_shareholder: 4 });
    /**
     * **`risk` is one of the two columns that do not simply take the newest
     * sighting** (SPEC §8.2 D5, item A). The old rule — overwrite in full — is
     * exactly the YAZAKI ROMANIA bug: a company with ten factors in a
     * traversal payload and six from `getEntity` is not the same company as
     * one with six, whichever sighting arrives second. So the `full` body's
     * `basel_aml` survives the `nested` body's `cpi_score`. `risk` itself
     * stays exactly `level`/`value`/`metadata` per factor — the shape does
     * not vary by how many sightings a factor has had (P1), only what lands
     * in it does: `level` is copied raw rather than filtered to the three
     * `RiskLevel` values, so a `critical` factor a later ticket adds here
     * would survive too. The provenance lands on the sibling `risk_sources`
     * column (see this file's "risk union by provenance" block below).
     */
    expect(row?.risk).toEqual({
      basel_aml: { level: 'relevant', value: null, metadata: {} },
      cpi_score: { level: 'relevant', value: null, metadata: {} },
    });
    expect(row?.risk_sources).toEqual({
      basel_aml: ['getEntity'],
      cpi_score: ['getEntity'],
    });
  });

  /** The 11-entity case: the same bug with the sightings the other way round. */
  it('fills in what a first partial sighting left empty', async () => {
    const db = await getTestDb();
    await testSql()`DELETE FROM entity WHERE id = ${ID}`;
    await upsertEntity(db, nested, undefined, 'getEntity');

    expect(await read()).toMatchObject({ psa_count: null, country: null, lei: null });

    await upsertEntity(db, full, undefined, 'getEntity');
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
    await upsertEntity(db, { ...full, sanctioned: true, closed: true } as SayariEntity, undefined, 'getEntity');
    expect(await read()).toMatchObject({ sanctioned: true, closed: true });

    await upsertEntity(db, { ...full, sanctioned: false, closed: false } as SayariEntity, undefined, 'getEntity');
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

    await upsertEntity(db, full, payload!.id as string, 'getEntity');
    expect((await read())?.upstream_response_id).toBe(payload!.id);

    await upsertEntity(db, nested, undefined, 'getEntity');
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
    await upsertEntity(db, full, undefined, 'getEntity');
    const before = await read();

    await new Promise((resolve) => setTimeout(resolve, 5));
    await upsertEntity(db, nested, undefined, 'getEntity');
    const after = await read();

    expect(after?.first_seen_at).toEqual(before?.first_seen_at);
    expect(new Date(after?.fetched_at as string).getTime()).toBeGreaterThan(
      new Date(before?.fetched_at as string).getTime(),
    );
  });
});

/**
 * **The risk union by provenance** (SPEC §8.2 D5, ticket 01 item A).
 *
 * Shaped from a real recorded body: `ООО "ЯЗАКИ ВОЛГА"`, a traversal terminal
 * in `tests/fixtures/enrich/yazaki.json`, carries exactly ten risk factors
 * including `exports_ilab_forced_labor` at `elevated`. The `getEntity` body
 * below is hand-built from the same shapes (SPEC §16.6's rule for a call with
 * no recorded body of its own), standing in for a later `getEntity` fetch of
 * the same company that only reports six of the ten — the YAZAKI ROMANIA
 * measurement this ticket cites: ten factors became six, and the forced-labour
 * factor was among the lost.
 */
describe.skipIf(!up)(`risk union by provenance (needs: ${START_TEST_DB_HINT})`, () => {
  const ID = 'yazaki-volga-fixture';

  /** The traversal terminal's own risk block, verbatim from the fixture. */
  const traversalRisk = {
    basel_aml: { level: 'relevant', value: 5.35, metadata: { country: ['RUS'] } },
    cpi_score: { level: 'relevant', value: 22, metadata: { country: ['RUS'] } },
    exports_ilab_child_labor: { level: 'elevated', value: true },
    exports_ilab_forced_labor: { level: 'elevated', value: true },
    psa_exports_ilab_child_labor: { level: 'elevated', value: true },
    psa_exports_ilab_forced_labor: { level: 'elevated', value: true },
    imports_bis_high_priority_items: { level: 'elevated', value: 1 },
    psa_imports_bis_high_priority_items: { level: 'elevated', value: 1 },
    exports_bis_high_priority_items_indirect: { level: 'elevated', value: 3 },
    psa_exports_bis_high_priority_items_indirect: { level: 'elevated', value: 3 },
  };

  /**
   * A later `getEntity` fetch of the same company: six of the ten factors,
   * and `basel_aml` reported one band worse than the traversal terminal said
   * — so the merge's "keep the worse level" rule has something to prove too.
   */
  const getEntityRisk = {
    basel_aml: { level: 'high', value: 6.1, metadata: { country: ['RUS'] } },
    cpi_score: { level: 'relevant', value: 22, metadata: { country: ['RUS'] } },
    imports_bis_high_priority_items: { level: 'elevated', value: 1 },
    psa_imports_bis_high_priority_items: { level: 'elevated', value: 1 },
    exports_bis_high_priority_items_indirect: { level: 'elevated', value: 3 },
    psa_exports_bis_high_priority_items_indirect: { level: 'elevated', value: 3 },
  };

  const traversalEntity = {
    id: ID,
    label: 'ООО "ЯЗАКИ ВОЛГА"',
    risk: traversalRisk,
  } as SayariEntity;

  const getEntityEntity = {
    id: ID,
    label: 'ООО "ЯЗАКИ ВОЛГА"',
    risk: getEntityRisk,
  } as SayariEntity;

  /**
   * `risk` and `risk_sources` are read separately — `risk` stays exactly
   * Sayari's own shape (`level`/`value`/`metadata`) because
   * `src/tools/catalog/reads.ts` hands it to a model turn verbatim; the
   * per-factor provenance this ticket adds lives on the sibling column
   * instead, and this pins that the two never merge back into one blob (see
   * the schema comment on `entity.risk`).
   */
  const read = async () => {
    const [row] = await testSql()`SELECT risk, risk_sources FROM entity WHERE id = ${ID}`;
    return {
      risk: (row?.risk ?? {}) as Record<string, { level: string }>,
      sources: (row?.risk_sources ?? {}) as Record<string, string[]>,
    };
  };

  afterAll(async () => {
    if (!up) return;
    await testSql()`DELETE FROM entity WHERE id = ${ID}`;
  });

  it('keeps all ten factors after a getEntity fetch reports six, with sources and the worst level', async () => {
    const db = await getTestDb();
    await testSql()`DELETE FROM entity WHERE id = ${ID}`;

    await upsertEntity(db, traversalEntity, undefined, 'traversal');
    await upsertEntity(db, getEntityEntity, undefined, 'getEntity');

    const { risk, sources } = await read();
    expect(Object.keys(risk).sort()).toEqual(Object.keys(traversalRisk).sort());
    expect(Object.keys(risk)).toHaveLength(10);
    // `risk` itself carries no extra key — Sayari's own shape, untouched.
    expect(Object.keys(risk.cpi_score as unknown as Record<string, unknown>).sort()).toEqual([
      'level',
      'metadata',
      'value',
    ]);

    // The four traversal-only factors survive, provenanced to `traversal` alone.
    expect(risk.exports_ilab_forced_labor).toMatchObject({ level: 'elevated' });
    expect(sources.exports_ilab_forced_labor).toEqual(['traversal']);
    expect(sources.psa_exports_ilab_child_labor).toEqual(['traversal']);

    // A factor both endpoints reported carries both sources...
    expect(sources.cpi_score?.sort()).toEqual(['getEntity', 'traversal']);
    // ...and where they disagree on level, the worse one is kept.
    expect(risk.basel_aml).toMatchObject({ level: 'high' });
    expect(sources.basel_aml).toEqual(['traversal', 'getEntity']);
  });

  it('gets the same ten back whichever order the two sightings arrive in', async () => {
    const db = await getTestDb();
    await testSql()`DELETE FROM entity WHERE id = ${ID}`;

    await upsertEntity(db, getEntityEntity, undefined, 'getEntity');
    await upsertEntity(db, traversalEntity, undefined, 'traversal');

    const { risk } = await read();
    expect(Object.keys(risk)).toHaveLength(10);
    expect(risk.basel_aml).toMatchObject({ level: 'high' });
  });
});

/**
 * **The merge must keep the raw factor object, not `parseRiskObject`'s
 * lossy reconstruction of one** (PR #19 review item P1).
 *
 * `parseRiskObject` exists to hand `entity.risk` to a model turn verbatim
 * (its own comment says so) and reads exactly `level`/`value`/
 * `metadata.country`/`metadata.traversal_path` — so a `level` outside
 * `high`/`elevated`/`relevant` becomes `undefined`, and every other
 * `metadata` key is dropped. `mergeRiskForUpsert` used to rebuild every
 * factor through it, which is wrong for a MERGE (as opposed to a read): a
 * factor Sayari reports at `level: "critical"` — measured 185 times in
 * recorded bodies, `risk.sanctioned` in `tests/fixtures/resolve/
 * sanctioned.json` among them — got its level silently voided and its
 * `metadata.source`/`metadata.from_date` silently dropped on the very next
 * upsert of that entity, from any endpoint, however small the new sighting.
 *
 * Shaped from that recorded fixture's own `risk.sanctioned` block (SPEC
 * §16.6's rule for a body built by hand rather than replaying a call).
 */
describe.skipIf(!up)(`raw risk merge keeps the factor object whole (needs: ${START_TEST_DB_HINT})`, () => {
  const ID = 'sanctioned-fixture-entity';

  const recordedRisk = {
    sanctioned: {
      level: 'critical',
      value: true,
      metadata: {
        source: [
          'Consolidated Canadian Autonomous Sanctions List',
          'Japan Ministry of Finance Economic Sanctions List',
          'Australia Consolidated Sanctions List',
        ],
        from_date: ['2022-03-10'],
      },
    },
    basel_aml: {
      level: 'relevant',
      value: 8.14,
      metadata: { country: ['MMR'] },
    },
  };

  const firstSighting = {
    id: ID,
    label: 'SANCTIONED ENTITY CO',
    risk: recordedRisk,
  } as SayariEntity;

  /**
   * A later, SMALLER sighting from a second endpoint: only `basel_aml`, and
   * at the SAME level — so the union has nothing to raise `basel_aml` to,
   * and `sanctioned` is entirely this sighting's silence, which is exactly
   * the case `parseRiskObject`'s reconstruction got wrong (it rebuilds
   * every merged factor, touched or not).
   */
  const laterSighting = {
    id: ID,
    label: 'SANCTIONED ENTITY CO',
    risk: { basel_aml: { level: 'relevant', value: 8.14, metadata: { country: ['MMR'] } } },
  } as SayariEntity;

  afterAll(async () => {
    if (!up) return;
    await testSql()`DELETE FROM entity WHERE id = ${ID}`;
  });

  it('keeps risk.sanctioned byte-equal to the recorded body after a smaller sighting merges in', async () => {
    const db = await getTestDb();
    await testSql()`DELETE FROM entity WHERE id = ${ID}`;

    await upsertEntity(db, firstSighting, undefined, 'getEntity');
    await upsertEntity(db, laterSighting, undefined, 'entitySummary');

    const [row] = await testSql()`SELECT risk FROM entity WHERE id = ${ID}`;
    const risk = row?.risk as Record<string, unknown>;

    // Byte-equal to the recorded body. `parseRiskObject` would have rebuilt
    // this as `{ level: null, value: true, metadata: {} }`.
    expect(risk.sanctioned).toEqual(recordedRisk.sanctioned);
    expect(risk.basel_aml).toEqual(recordedRisk.basel_aml);
    // The union holds every factor the two sightings ever reported.
    expect(Object.keys(risk).sort()).toEqual(['basel_aml', 'sanctioned']);
  });
});

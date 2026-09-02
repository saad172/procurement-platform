import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as t from '@/db/schema';
import { deriveSettledCountry, settleMatch } from '@/domain/match/settle-match';
import { siteCountryOf } from '@/jobs/enrich-supplier';
import { getTestDb, testDatabaseIsUp } from '../support/test-db';
import { resetDerived } from '../support/reset';
import { seededProgram } from '../support/seeded-program';

/**
 * **The country a Supplier is scored on** (SPEC §9.4).
 *
 * The Match decides it at settle time and writes it to
 * `match.settled_country` / `match.settled_country_source`; enrichment reads
 * the row and never re-derives it.
 *
 * Sumitomo Electric is the measured case this exists for: settled by rules to
 * the right entity, whose `entity.country` reads `SWE` against a Japanese
 * roster address, because the Profile's country and the settled site's country
 * are two different facts (CONTEXT.md, *Profile*). Its own LEI is registered in
 * Japan, and that is now what decides.
 *
 * The rule this replaces scored the **roster's** country whenever the `country`
 * Discriminator passed. It was right about Sumitomo Electric and wrong in
 * principle: the roster is the claim under test, not a witness to it — and a
 * value derived from Discriminator verdicts moves whenever a Match is
 * re-recorded, silently rescoring a Supplier nobody touched.
 */

const TEST_ROSTER_NAME = 'Site Country Test Co';

/**
 * `deriveSettledCountry` is pure, so the three sources are tested directly and
 * the database level below only has to show that what it decided is what gets
 * stored and read back.
 */
describe('deriveSettledCountry — three sources, in order of what each witnesses', () => {
  it("prefers GLEIF's legal-address country when the settled Candidate has an LEI", () => {
    // Sumitomo Electric, measured: LEI 5493005SP87FL5TOS202, GLEIF legal
    // address country JP, Sayari's `countries[0]` SWE.
    expect(
      deriveSettledCountry({
        evidence: {
          lei: '5493005SP87FL5TOS202',
          gleifLegalCountry: 'JP',
          anchoredAddressCountry: 'JPN',
        },
        profileCountry: 'SWE',
      }),
    ).toEqual({ country: 'JPN', source: 'gleif' });
  });

  it('falls to the anchored address when there is an LEI but no GLEIF country', () => {
    // The GLEIF join can miss or return a record with no legal address; absence
    // is not evidence, so the next witness answers rather than the fallback.
    expect(
      deriveSettledCountry({
        evidence: {
          lei: 'SOMELEI000000000000',
          gleifLegalCountry: null,
          anchoredAddressCountry: 'DEU',
        },
        profileCountry: 'BEL',
      }),
    ).toEqual({ country: 'DEU', source: 'matched_address' });
  });

  it('uses the anchored address when the record carries no LEI at all', () => {
    // A company with no LEI can never be auto-accepted, but the agents settle
    // plenty of them — Draexlmaier, Yazaki, NSK — and the building the
    // Discriminators anchored on is still the site.
    expect(
      deriveSettledCountry({
        evidence: { lei: null, gleifLegalCountry: null, anchoredAddressCountry: 'JPN' },
        profileCountry: 'USA',
      }),
    ).toEqual({ country: 'JPN', source: 'matched_address' });
  });

  it("falls back to the Profile's own country when there is no evidence at all", () => {
    // A human override and a promoted Lead both arrive with no Discriminator
    // run behind them, and `'profile'` is the honest source for both.
    expect(deriveSettledCountry({ profileCountry: 'SWE' })).toEqual({
      country: 'SWE',
      source: 'profile',
    });
  });

  it('reads whatever spelling a source gives it, and refuses what it cannot place', () => {
    // GLEIF is ISO2, Sayari is ISO3, and a country name occasionally arrives.
    expect(
      deriveSettledCountry({
        evidence: { lei: 'X', gleifLegalCountry: 'Germany', anchoredAddressCountry: null },
        profileCountry: null,
      }).country,
    ).toBe('DEU');
    expect(deriveSettledCountry({ profileCountry: 'Ruritania' })).toEqual({
      country: null,
      source: null,
    });
  });
});

type Setup = { supplierId: string; entityId: string };

/**
 * One Supplier and one entity of our own.
 *
 * `supplier` is authored data (`src/db/schema/authored.ts`) — `resetDerived`
 * leaves it alone by design — so a leftover row from a prior run of this same
 * test is deleted by name first, rather than by picking an ever-larger roster
 * index to dodge it.
 */
async function seedSupplierAndEntity(
  db: Awaited<ReturnType<typeof getTestDb>>,
  args: { rosterCountry: string | null; profileCountry: string | null },
): Promise<Setup> {
  const program = await seededProgram(db);
  const entityId = `test-entity-${crypto.randomUUID()}`;

  await db.insert(t.entity).values({
    id: entityId,
    label: 'Test Entity',
    country: args.profileCountry,
  });

  await db
    .delete(t.supplier)
    .where(and(eq(t.supplier.programId, program.id), eq(t.supplier.rosterName, TEST_ROSTER_NAME)));

  const [supplier] = await db
    .insert(t.supplier)
    .values({
      programId: program.id,
      origin: 'imported',
      rosterIndex: 9001,
      rosterName: TEST_ROSTER_NAME,
      rosterAddress: '1 Test Street',
      rosterCountry: args.rosterCountry,
    })
    .returning({ id: t.supplier.id });

  return { supplierId: supplier!.id, entityId };
}

async function settledMatchRow(db: Awaited<ReturnType<typeof getTestDb>>, supplierId: string) {
  const match = await db.query.match.findFirst({ where: eq(t.match.supplierId, supplierId) });
  return { ...match!, entityId: match!.entityId! };
}

describe('settleMatch writes the country, and enrichment reads it back', () => {
  it("stores GLEIF's country on the Match — Sumitomo Electric's shape", async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);

    const setup = await seedSupplierAndEntity(db, { rosterCountry: 'JPN', profileCountry: 'SWE' });
    await settleMatch(db, {
      supplierId: setup.supplierId,
      status: 'accepted',
      entityId: setup.entityId,
      settledBy: 'rules',
      settledEvidence: {
        lei: '5493005SP87FL5TOS202',
        gleifLegalCountry: 'JP',
        anchoredAddressCountry: 'JPN',
      },
    });

    const match = await settledMatchRow(db, setup.supplierId);
    expect(match.settledCountry).toBe('JPN');
    expect(match.settledCountrySource).toBe('gleif');

    // What the enrich fan-out and the Score will read. The Profile's own SWE is
    // still on the entity row, which is the point: both facts survive.
    const profileRow = await db.query.entity.findFirst({ where: eq(t.entity.id, setup.entityId) });
    expect(siteCountryOf(match, profileRow!)).toEqual({
      siteCountry: 'JPN',
      countrySource: 'gleif',
    });
    expect(profileRow!.country).toBe('SWE');
  });

  it('stores the anchored address’s country where there is no LEI', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);

    const setup = await seedSupplierAndEntity(db, { rosterCountry: 'JPN', profileCountry: 'SWE' });
    await settleMatch(db, {
      supplierId: setup.supplierId,
      status: 'accepted',
      entityId: setup.entityId,
      settledBy: 'agents',
      settledEvidence: { lei: null, gleifLegalCountry: null, anchoredAddressCountry: 'JPN' },
    });

    const match = await settledMatchRow(db, setup.supplierId);
    expect(match.settledCountry).toBe('JPN');
    expect(match.settledCountrySource).toBe('matched_address');
  });

  it("falls back to the Profile's own country on a settlement with no evidence", async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);

    // A human override: a person picked a Candidate, and no Discriminator run
    // stands behind the pick.
    const setup = await seedSupplierAndEntity(db, { rosterCountry: 'JPN', profileCountry: 'SWE' });
    await settleMatch(db, {
      supplierId: setup.supplierId,
      status: 'accepted',
      entityId: setup.entityId,
      settledBy: 'human',
    });

    const match = await settledMatchRow(db, setup.supplierId);
    expect(match.settledCountry).toBe('SWE');
    expect(match.settledCountrySource).toBe('profile');
  });

  it('leaves both columns null on a parked Match, which has no site', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);

    const setup = await seedSupplierAndEntity(db, { rosterCountry: 'JPN', profileCountry: 'SWE' });
    await settleMatch(db, {
      supplierId: setup.supplierId,
      status: 'needs_review',
      entityId: null,
      settledBy: 'agents',
    });

    const match = await db.query.match.findFirst({
      where: eq(t.match.supplierId, setup.supplierId),
    });
    expect(match?.settledCountry).toBeNull();
    expect(match?.settledCountrySource).toBeNull();
  });

  it("reads the Profile's own country for a Match settled before the column existed", async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);

    // Every accepted Match in the development database is one of these until it
    // is re-run, and `'profile'` is exactly what it was scored on before.
    const setup = await seedSupplierAndEntity(db, { rosterCountry: 'JPN', profileCountry: 'SWE' });
    const [match] = await db
      .insert(t.match)
      .values({
        supplierId: setup.supplierId,
        status: 'accepted',
        entityId: setup.entityId,
        settledBy: 'rules',
      })
      .returning();
    const profileRow = await db.query.entity.findFirst({ where: eq(t.entity.id, setup.entityId) });

    expect(siteCountryOf({ ...match!, entityId: match!.entityId! }, profileRow!)).toEqual({
      siteCountry: 'SWE',
      countrySource: 'profile',
    });
  });
});

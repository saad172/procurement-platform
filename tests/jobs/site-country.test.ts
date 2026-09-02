import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as t from '@/db/schema';
import { deriveSiteCountry } from '@/jobs/enrich-supplier';
import { getTestDb, testDatabaseIsUp } from '../support/test-db';
import { resetDerived } from '../support/reset';
import { seededProgram } from '../support/seeded-program';

/**
 * `deriveSiteCountry` (SPEC §9.2/§9.4, finding 107).
 *
 * **Rule:** when the settled candidate's persisted `country` Discriminator
 * verdict is `pass`, the site is scored on the roster's country, normalised to
 * ISO3; otherwise on the Profile's own — exactly as before this finding.
 *
 * Sumitomo Electric is the measured case this exists for: settled by rules to
 * the right entity, whose `entity.country` reads `SWE` against a Japanese
 * roster address, because the Profile's country and the settled site's country
 * are two different facts (CONTEXT.md, *Profile*; `src/domain/scoring/types.ts`).
 * These tests build the same shape from scratch rather than depending on that
 * live data, so they run offline and keyless.
 */

type Setup = {
  supplierId: string;
  entityId: string;
  matchId: string;
};

const TEST_ROSTER_NAME = 'Site Country Test Co';

/**
 * One accepted Match, with an `entity` row and a `supplier` row of our own.
 *
 * `supplier` is authored data (`src/db/schema/authored.ts`) — `resetDerived`
 * leaves it alone by design — so a leftover row from a prior run of this same
 * test is deleted by name first, rather than by picking an ever-larger roster
 * index to dodge it.
 */
async function seedAcceptedMatch(
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

  const [match] = await db
    .insert(t.match)
    .values({
      supplierId: supplier!.id,
      status: 'accepted',
      entityId,
      settledBy: 'rules',
    })
    .returning({ id: t.match.id });

  return { supplierId: supplier!.id, entityId, matchId: match!.id };
}

/** One Candidate on the settled entity, carrying one `country` verdict. */
async function recordCountryVerdict(
  db: Awaited<ReturnType<typeof getTestDb>>,
  setup: Setup,
  verdict: 'pass' | 'fail' | 'unavailable',
): Promise<void> {
  const [attempt] = await db
    .insert(t.matchAttempt)
    .values({
      matchId: setup.matchId,
      attemptN: 1,
      outcomeStatus: 'accepted',
      outcomeEntityId: setup.entityId,
      settledBy: 'rules',
    })
    .returning({ id: t.matchAttempt.id });

  const [candidate] = await db
    .insert(t.matchCandidate)
    .values({ matchAttemptId: attempt!.id, entityId: setup.entityId, foundByRung: 'R1' })
    .returning({ id: t.matchCandidate.id });

  await db.insert(t.matchCandidateVerdict).values({
    matchCandidateId: candidate!.id,
    discriminator: 'country',
    verdict,
    reasoning: 'seeded for the site-country unit test',
    reportedBy: 'rules',
  });
}

/** Loads the accepted `match` row the way `enrich-supplier.ts` narrows it. */
async function acceptedMatchRow(db: Awaited<ReturnType<typeof getTestDb>>, matchId: string) {
  const match = await db.query.match.findFirst({ where: eq(t.match.id, matchId) });
  return { ...match!, entityId: match!.entityId! };
}

describe('deriveSiteCountry', () => {
  it('a pass verdict scores the roster country, given as ISO3', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);

    const setup = await seedAcceptedMatch(db, { rosterCountry: 'JPN', profileCountry: 'SWE' });
    await recordCountryVerdict(db, setup, 'pass');
    const supplier = await db.query.supplier.findFirst({
      where: eq(t.supplier.id, setup.supplierId),
    });
    const profileRow = await db.query.entity.findFirst({ where: eq(t.entity.id, setup.entityId) });
    const match = await acceptedMatchRow(db, setup.matchId);

    const result = await deriveSiteCountry(db, match, supplier!, profileRow!);
    expect(result).toEqual({ siteCountry: 'JPN', countrySource: 'site' });
  });

  it('a pass verdict scores the roster country, given as prose', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);

    const setup = await seedAcceptedMatch(db, { rosterCountry: 'Japan', profileCountry: 'SWE' });
    await recordCountryVerdict(db, setup, 'pass');
    const supplier = await db.query.supplier.findFirst({
      where: eq(t.supplier.id, setup.supplierId),
    });
    const profileRow = await db.query.entity.findFirst({ where: eq(t.entity.id, setup.entityId) });
    const match = await acceptedMatchRow(db, setup.matchId);

    const result = await deriveSiteCountry(db, match, supplier!, profileRow!);
    expect(result).toEqual({ siteCountry: 'JPN', countrySource: 'site' });
  });

  it('a fail verdict falls back to the Profile country', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);

    const setup = await seedAcceptedMatch(db, { rosterCountry: 'JPN', profileCountry: 'SWE' });
    await recordCountryVerdict(db, setup, 'fail');
    const supplier = await db.query.supplier.findFirst({
      where: eq(t.supplier.id, setup.supplierId),
    });
    const profileRow = await db.query.entity.findFirst({ where: eq(t.entity.id, setup.entityId) });
    const match = await acceptedMatchRow(db, setup.matchId);

    const result = await deriveSiteCountry(db, match, supplier!, profileRow!);
    expect(result).toEqual({ siteCountry: 'SWE', countrySource: 'profile' });
  });

  it('an unavailable verdict falls back to the Profile country', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);

    const setup = await seedAcceptedMatch(db, { rosterCountry: 'JPN', profileCountry: 'SWE' });
    await recordCountryVerdict(db, setup, 'unavailable');
    const supplier = await db.query.supplier.findFirst({
      where: eq(t.supplier.id, setup.supplierId),
    });
    const profileRow = await db.query.entity.findFirst({ where: eq(t.entity.id, setup.entityId) });
    const match = await acceptedMatchRow(db, setup.matchId);

    const result = await deriveSiteCountry(db, match, supplier!, profileRow!);
    expect(result).toEqual({ siteCountry: 'SWE', countrySource: 'profile' });
  });

  it('no verdict at all (a promoted Lead, zero candidates) falls back to the Profile country', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);

    // No `recordCountryVerdict` call: zero `match_attempt` rows, exactly like a
    // promoted Lead's pre-settled Match (`settleDiscoveredLead`).
    const setup = await seedAcceptedMatch(db, { rosterCountry: 'JPN', profileCountry: 'SWE' });
    const supplier = await db.query.supplier.findFirst({
      where: eq(t.supplier.id, setup.supplierId),
    });
    const profileRow = await db.query.entity.findFirst({ where: eq(t.entity.id, setup.entityId) });
    const match = await acceptedMatchRow(db, setup.matchId);

    const result = await deriveSiteCountry(db, match, supplier!, profileRow!);
    expect(result).toEqual({ siteCountry: 'SWE', countrySource: 'profile' });
  });

  it('a pass verdict with no roster country at all falls back to the Profile country', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);

    const setup = await seedAcceptedMatch(db, { rosterCountry: null, profileCountry: 'SWE' });
    const supplier = await db.query.supplier.findFirst({
      where: eq(t.supplier.id, setup.supplierId),
    });
    const profileRow = await db.query.entity.findFirst({ where: eq(t.entity.id, setup.entityId) });
    const match = await acceptedMatchRow(db, setup.matchId);

    const result = await deriveSiteCountry(db, match, supplier!, profileRow!);
    expect(result).toEqual({ siteCountry: 'SWE', countrySource: 'profile' });
  });
});

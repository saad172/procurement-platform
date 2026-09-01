import { describe, expect, it } from 'vitest';
import { citationKey, resolveCitations } from '@/jobs/publish';
import { getTestDb, testDatabaseIsUp } from '../support/test-db';

/**
 * A Citation whose id is the wrong SHAPE must become an objection, never a
 * thrown query.
 *
 * Every id column here is a uuid, and Postgres answers a malformed one with a
 * thrown type error rather than an empty result — so a throw escapes the
 * validator entirely and fails the Job on a database error, where an objection
 * would have told the model what to send.
 *
 * It happened: a recommendation cited `programId: "MY2029-CROSSOVER-BEV-NA"`, a
 * slug the model invented because the field said what it was FOR and not where
 * it comes FROM.
 */
describe('resolveCitations refuses a malformed id', () => {
  const cases = [
    {
      name: 'a shortlist naming the program by slug',
      citation: { shortlist: { programId: 'MY2029-CROSSOVER-BEV-NA', categoryId: 'HAR' } },
    },
    { name: 'a match id that is not a uuid', citation: { matchId: 'Yazaki' } },
    { name: 'an enrichment id that is not a uuid', citation: { enrichmentId: 'gleif' } },
    {
      name: 'a criterion value id that is not a uuid',
      citation: { criterionValueId: 'compliance_risk' },
    },
  ];

  it.each(cases)('resolves $name to nothing, without throwing', async ({ citation }) => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();

    const rows = await resolveCitations(db, [citation as never]);
    expect(rows.get(citationKey(citation as never))).toBeUndefined();
  });

  it('leaves a Sayari entity id alone, because it is not a uuid column', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();

    // `entity.id` is text — a Sayari id, 22 chars of base64url. It must still
    // resolve, and a missing one is simply absent rather than an error.
    const citation = { entityId: 'CX3012yTGIhgMxcZG6hgnA' };
    await expect(resolveCitations(db, [citation as never])).resolves.toBeDefined();
  });
});

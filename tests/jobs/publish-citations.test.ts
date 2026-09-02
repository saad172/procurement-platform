import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as t from '@/db/schema';
import { citationKey, resolveCitations } from '@/jobs/publish';
import { candidatesFrom, checkNumberFidelity } from '@/domain/validation/number-fidelity';
import { getTestDb, testDatabaseIsUp } from '../support/test-db';
import { resetDerived } from '../support/reset';
import { buildAssessableSupplier } from '../support/pipeline';

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

  /**
   * **Two different Shortlists are two different citations.**
   *
   * `citationKey` was `JSON.stringify(c, Object.keys(c).sort())`, and a
   * replacer *array* filters keys at every depth rather than ordering the top
   * level — so every shortlist citation serialised as `{"shortlist":{}}`. The
   * lookup dedupes by this key, so the first pair in a document was resolved
   * and its answer reused for every other one, and a bogus pair rode through
   * the validator to fail on a foreign key three Rounds later.
   */
  it('gives two different shortlists two different keys', () => {
    const one = { shortlist: { programId: 'p-1', categoryId: 'c-1' } };
    const two = { shortlist: { programId: 'p-1', categoryId: 'c-2' } };

    expect(citationKey(one as never)).not.toBe(citationKey(two as never));
    // And the nested ids are in the key at all, which is what went missing.
    expect(citationKey(one as never)).toContain('c-1');
  });

  it('is insensitive to the order the model happened to write the fields in', () => {
    // The key is an identity, not a serialisation of one turn's typing order.
    const written = { shortlist: { categoryId: 'c-1', programId: 'p-1' } };
    const stored = { shortlist: { programId: 'p-1', categoryId: 'c-1' } };
    expect(citationKey(written as never)).toBe(citationKey(stored as never));
  });

  it('resolves a bogus (program, category) pair to nothing even beside a real one', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();

    // Both halves are well-shaped uuids, so nothing here is caught by shape;
    // what catches it is that the pair does not exist, and that the second
    // citation is looked up at all.
    const real = { shortlist: { programId: crypto.randomUUID(), categoryId: crypto.randomUUID() } };
    const bogus = {
      shortlist: { programId: real.shortlist.programId, categoryId: crypto.randomUUID() },
    };

    const rows = await resolveCitations(db, [real, bogus] as never[]);
    expect(rows.size, 'the second pair was never queried at all').toBe(2);
    expect(rows.get(citationKey(bogus as never))).toBeUndefined();
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

/**
 * A Corporate family Enrichment resolves to a row carrying the figures the tool
 * printed (finding 106).
 *
 * `get_supplier_family` says *"explored: 45"*; the `enrichment` row it points
 * at is a registry entry — source, subject, `fetched_at` — and holds no such
 * number. So a true sentence, citing exactly the right Enrichment, was refused
 * by the number check for a figure the model had read off our own payload.
 */
describe('the family walk’s coverage is citable', () => {
  it('carries explored and truncated onto the enrichment a sentence cites', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);
    const { supplierId } = await buildAssessableSupplier(db, 'Yazaki');

    const match = await db.query.match.findFirst({ where: eq(t.match.supplierId, supplierId) });
    const [member] = await db
      .select()
      .from(t.familyMember)
      .where(eq(t.familyMember.rootEntityId, match!.entityId!))
      .limit(1);
    expect(member, 'the Yazaki fixture holds a corporate family').toBeDefined();

    const citation = { enrichmentId: member!.enrichmentId };
    const rows = await resolveCitations(db, [citation as never]);
    const row = rows.get(citationKey(citation as never))!;
    expect(row.explored).toBe(member!.exploredCount);
    expect(row.truncated).toBe(member!.truncated);

    // And the check reads it: the count the tool printed now matches a
    // candidate on the row the sentence points at.
    const failures = checkNumberFidelity(
      `The downward family reached ${member!.exploredCount} members.`,
      candidatesFrom({}, [row]),
    );
    expect(failures).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as t from '@/db/schema';
import { getRegistry } from '@/tools';
import { citationKey, resolveCitations } from '@/jobs/publish';
import { loadFixture } from '@/fixtures/load';
import { replayUpstream, seedUpstream } from '@/fixtures/replay-upstream';
import { seededProgram } from '../support/seeded-program';
import { getTestDb, testDatabaseIsUp } from '../support/test-db';
import { resetDerived } from '../support/reset';

/**
 * **The bottom of the citation hop, proved offline.**
 *
 * A Citation may point at a Sayari source record, and §13.1 puts a page at the
 * end of that hop. For any of it to work, three things have to line up:
 *
 * 1. `sayari_get_record` must **store** what it fetches — its description says a
 *    record id *"has no local row until something fetches it"*, and for a long
 *    while nothing wrote to `record` at all (finding 86);
 * 2. it must store the row under the id a **Citation will carry** — the plain
 *    path visible inside an entity, not the percent-encoded form `getRecord`
 *    echoes back;
 * 3. `resolveCitations` must then find it.
 *
 * Each was broken, and each was invisible on its own: the fetch succeeded, the
 * row was absent, and the failure surfaced three layers away as a rejected
 * sentence.
 *
 * The whole chain runs here from **cached bodies with no credentials** — a
 * keyless wrapper cannot fall through to a live call, so this proves the path
 * rather than the network.
 */

const FIXTURE = 'record/one-source';

describe('a citation to a source record', () => {
  it('fetches, stores under the citable id, and resolves', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    const fixture = await loadFixture(FIXTURE);

    await resetDerived(db);
    await seedUpstream(db, fixture);

    const program = await seededProgram(db);
    const [run] = await db
      .insert(t.run)
      .values({
        programId: program.id,
        state: 'running',
        trigger: 'full',
        subjectLabel: 'record hop',
      })
      .returning({ id: t.run.id });

    // The id as it appears INSIDE an entity: a plain three-part path. This is
    // the spelling a model can see, so it is the spelling a Citation carries.
    const recordId = (fixture.upstream[0]!.params as { id: string }).id;
    expect(recordId).toContain('/');
    expect(recordId).not.toContain('%2F');

    const upstream = replayUpstream(db, run!.id);
    const result = await getRegistry()
      .byName.get('sayari_get_record')!
      .handler(
        { recordId } as never,
        {
          db,
          upstream,
          meter: { addModelTokens: () => {} },
          runId: run!.id,
          surface: 'job',
        } as never,
      );
    expect(result.ok, 'the record could not be fetched from the cached body').toBe(true);

    // ── 1. It stored something ────────────────────────────────────────────
    const stored = await db.query.record.findFirst({ where: eq(t.record.id, recordId) });
    expect(stored, 'sayari_get_record fetched and stored nothing').toBeDefined();

    // ── 2. Under the citable id, not the echoed one ───────────────────────
    expect(stored?.id).toBe(recordId);
    expect(stored?.fields, 'the row keeps what the source recorded').toBeTruthy();

    // ── 3. And a Citation naming it resolves ──────────────────────────────
    const citation = { recordId };
    const rows = await resolveCitations(db, [citation as never]);
    expect(
      rows.get(citationKey(citation as never)),
      'a citation to the fetched record still points at nothing',
    ).toBeDefined();
  });

  it('refuses a citation to a record nobody fetched', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();

    // The rule the hop exists to enforce: a Citation points at a LIVE LOCAL
    // ROW. An id that was never fetched resolves to nothing, and the sentence
    // carrying it cannot be inserted.
    const citation = { recordId: 'deadbeef/{NEVER-FETCHED}/1672531200000' };
    const rows = await resolveCitations(db, [citation as never]);
    expect(rows.get(citationKey(citation as never))).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as t from '@/db/schema';
import { getRegistry } from '@/tools';
import type { Estimate, ToolContext } from '@/tools';
import { loadFixture } from '@/fixtures/load';
import { replayUpstream, seedUpstream } from '@/fixtures/replay-upstream';
import { getTestDb, testDatabaseIsUp, type TestDb } from '../support/test-db';
import { resetDerived } from '../support/reset';
import { seededProgram } from '../support/seeded-program';

/**
 * The confirm gate's Estimate is about **one entity**.
 *
 * ## Why this test exists
 *
 * `cachedUpstreamFor()` null-checked its `entityId` and then asked whether
 * `upstream_response` held *any* row on `endpoint = 'entity.getEntity'`. With
 * fifty accepted Matches that is always true, so every enrichment proposal —
 * for a Supplier nothing had ever fetched as much as once — offered *"cached —
 * no credits, no wait"* and a flat `sayariCalls: 0`. The one control that stops
 * a spend before it happens was reading a number that had nothing to do with
 * the Supplier on screen.
 *
 * Nothing caught it because the estimators had no test at all: the replay
 * fixtures assert that a confirm was *frozen onto a message*
 * (`tests/model/chat-replay.test.ts`), not what it said.
 *
 * So the assertion here is the one the old query could not pass: two Suppliers,
 * one cached body, **two different answers**.
 *
 * Offline. The cached bodies come from a committed fixture, recorded through
 * `call()`; no credentials, no credits.
 */

/**
 * A Sayari-shaped id no committed fixture holds a body for. The test asserts
 * that below rather than trusting it, so a re-recorded fixture says so.
 */
const UNCACHED_ENTITY = 'zzTestEntityNeverFetched';

describe('enqueue_enrichment’s estimate', () => {
  it('reports cached for the entity whose body is stored, and not for another', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();

    await resetDerived(db);
    const program = await seededProgram(db);

    // Seven `entity.getEntity` bodies, for seven different entities, keyed the
    // way `call()` keyed them when the recorder ran. Under the old query any
    // one of them made every proposal look cached.
    const fixture = await loadFixture('resolve/agree-r1');
    await seedUpstream(db, fixture);
    const cachedIds = fixture.upstream
      .filter((row) => row.endpoint === 'entity.getEntity')
      .map((row) => (row.params as { id?: string }).id);
    expect(cachedIds.length).toBeGreaterThan(0);
    expect(cachedIds).not.toContain(UNCACHED_ENTITY);

    const [supplierA, supplierB] = await twoSuppliers(db, program.id);
    await settleOn(db, supplierA, cachedIds[0]!);
    await settleOn(db, supplierB, UNCACHED_ENTITY);
    const runId = await openEstimateRun(db, program.id);

    const onA = await estimate(db, runId, { supplierId: supplierA });
    const onB = await estimate(db, runId, { supplierId: supplierB });

    // ── The regression itself ───────────────────────────────────────────────
    // B's body is not in the table, and a table full of other entities' bodies
    // is not an answer about B.
    expect(onB.cached).toBe(false);
    expect(onB.spends.sayariCalls).toEqual({ min: 2, max: 4 });

    // A's is, and the gate may still say so — the fix narrows the claim, it
    // does not withdraw it.
    expect(onA.cached).toBe(true);
    expect(onA.spends.sayariCalls).toBe(0);

    // `refresh` asks for a re-fetch, so a stored body is not an answer either.
    const refreshed = await estimate(db, runId, { supplierId: supplierA, refresh: true });
    expect(refreshed.cached).toBe(false);
  });

  /** No Match, no entity, nothing to be cached about — and no crash. */
  it('is not cached for a supplier whose match is unsettled', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();

    await resetDerived(db);
    const program = await seededProgram(db);
    await seedUpstream(db, await loadFixture('resolve/agree-r1'));

    const [supplier] = await twoSuppliers(db, program.id);
    const runId = await openEstimateRun(db, program.id);

    const withoutAMatch = await estimate(db, runId, { supplierId: supplier });
    expect(withoutAMatch.cached).toBe(false);
  });
});

/** Two Suppliers of the approved Program, in roster order so the pick is stable. */
async function twoSuppliers(db: TestDb, programId: string): Promise<[string, string]> {
  const rows = await db
    .select({ id: t.supplier.id })
    .from(t.supplier)
    .where(eq(t.supplier.programId, programId))
    .orderBy(t.supplier.rosterIndex)
    .limit(2);
  if (rows.length < 2) throw new Error('the approved Program has fewer than two seeded suppliers');
  return [rows[0]!.id, rows[1]!.id];
}

/**
 * A settled Match on an entity — the only thing the estimator reads a Supplier
 * for. Written directly rather than resolved, because what is under test is the
 * lookup, not how the Match got there.
 */
async function settleOn(db: TestDb, supplierId: string, entityId: string): Promise<void> {
  await db.insert(t.entity).values({ id: entityId, label: entityId }).onConflictDoNothing();
  await db.insert(t.match).values({
    supplierId,
    status: 'accepted',
    entityId,
    settledBy: 'human',
  });
}

/** A real Run row, so `ctx.runId` is a Run and not a plausible-looking uuid. */
async function openEstimateRun(db: TestDb, programId: string): Promise<string> {
  const [run] = await db
    .insert(t.run)
    .values({
      programId,
      state: 'running',
      trigger: 'thread',
      subjectLabel: 'estimate only',
    })
    .returning({ id: t.run.id });
  return run!.id;
}

/**
 * The gate as chat reaches it: the registry's own tool, its `confirm`, and a
 * keyless upstream wrapper — which an estimator must never touch, and this one
 * could not spend through if it did.
 */
async function estimate(
  db: TestDb,
  runId: string,
  input: { supplierId: string; refresh?: boolean },
): Promise<Estimate> {
  const ctx: ToolContext = {
    db,
    upstream: replayUpstream(db, runId),
    meter: { addModelTokens: () => {} },
    runId,
    surface: 'chat',
  };
  const tool = getRegistry().byName.get('enqueue_enrichment')!;
  return tool.confirm!(input, ctx);
}

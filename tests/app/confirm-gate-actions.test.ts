import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as t from '@/db/schema';
import { loadEnv, resetEnvForTesting } from '@/config/env';
import { closePooledDb } from '@/db/client';
import { resetRegistryForTesting } from '@/tools';
import type {
  estimateJobStart as EstimateJobStart,
  runConfirmedJobStart as RunConfirmedJobStart,
} from '@/components/confirm-gate-actions';
import { TEST_DATABASE_URL, getTestDb, testDatabaseIsUp, type TestDb } from '../support/test-db';
import { seededProgram } from '../support/seeded-program';

/**
 * The page-native confirm gate's Server Actions
 * (`src/components/confirm-gate-actions.ts`, ticket 05 unit 05g) — the
 * estimate-then-confirm two-step flow, proven the same way
 * `tests/app/confirm-route.test.ts` proves chat's own gate: against the real
 * tool registry and the real test database, `loadEnv` pointed at
 * `TEST_DATABASE_URL` with fake upstream credentials that are never read
 * (network spec §8's "No live Sayari call from the browser" — a job-start
 * tool's `confirm`/`handler` never touches `ctx.upstream`, this file's own
 * doc comment).
 *
 * `enqueue_deep_traversal` is exercised end to end (it is the one tool this
 * ticket wires to a page), plus the generic guard rails — an unknown tool
 * name, and a real tool that is not a confirm-gated job-start one — which
 * prove the two functions are not secretly Deep-Traversal-specific.
 */

const up = await testDatabaseIsUp();

describe.skipIf(!up)('estimateJobStart / runConfirmedJobStart', () => {
  let db: TestDb;
  let estimateJobStart: typeof EstimateJobStart;
  let runConfirmedJobStart: typeof RunConfirmedJobStart;
  let entityId: string;
  let programId: string;
  /** A Run `runConfirmedJobStart` opened, taken away again in `afterAll`. */
  let openedRunId: string | undefined;

  beforeAll(async () => {
    db = await getTestDb();

    resetEnvForTesting();
    resetRegistryForTesting();
    loadEnv({
      DATABASE_URL: TEST_DATABASE_URL,
      DIRECT_DATABASE_URL: TEST_DATABASE_URL,
      SAYARI_CLIENT_ID: 'not-a-key',
      SAYARI_CLIENT_SECRET: 'not-a-key',
      ANTHROPIC_API_KEY: 'not-a-key',
    });
    ({ estimateJobStart, runConfirmedJobStart } = await import('@/components/confirm-gate-actions'));

    const program = await seededProgram(db);
    programId = program.id;
    entityId = 'test-confirm-gate-actions-entity';
    await db
      .insert(t.entity)
      .values({ id: entityId, label: 'Confirm Gate Actions Entity', country: 'JPN' })
      .onConflictDoNothing();
  });

  afterAll(async () => {
    if (!up) return;
    if (openedRunId) await db.delete(t.run).where(eq(t.run.id, openedRunId));
    await db.delete(t.entity).where(eq(t.entity.id, entityId));
    await closePooledDb();
    resetEnvForTesting();
  });

  it('estimateJobStart reads a real Estimate from local rows only, for enqueue_deep_traversal', async () => {
    const result = await estimateJobStart('enqueue_deep_traversal', { entityId, programId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.estimate.what).toMatch(/ownership graph/i);
    expect(result.estimate.spends.sayariCalls).toBeTruthy();
    expect(result.estimate.caveats.length).toBeGreaterThan(0);
  });

  it('runConfirmedJobStart actually enqueues — a real traverse Job, in a new Run', async () => {
    const before = await db.select().from(t.job).where(eq(t.job.subjectId, entityId));
    expect(before).toHaveLength(0);

    const result = await runConfirmedJobStart('enqueue_deep_traversal', { entityId, programId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    openedRunId = result.runId;

    const jobs = await db.select().from(t.job).where(eq(t.job.subjectId, entityId));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.kind).toBe('traverse');
    expect(jobs[0]!.runId).toBe(result.runId);
  });

  it('refuses an unknown tool name, for both steps, without throwing', async () => {
    const estimate = await estimateJobStart('not_a_real_tool', {});
    expect(estimate.ok).toBe(false);
    if (estimate.ok) return;
    expect(estimate.error).toMatch(/no such tool/i);

    const confirmed = await runConfirmedJobStart('not_a_real_tool', {});
    expect(confirmed.ok).toBe(false);
    if (confirmed.ok) return;
    expect(confirmed.objections.join(' ')).toMatch(/no such tool/i);
  });

  it('refuses a real tool that is not a confirm-gated job-start tool (Family 1, a page read)', async () => {
    // `get_program` exists, is confirm-free, and enqueues nothing — this
    // file's own guard against being handed the wrong kind of tool by
    // mistake, proven with a REAL registry entry rather than a stub.
    const result = await estimateJobStart('get_program', { programId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/does not start a job/i);
  });

  it('refuses input that fails the tool’s own Zod schema, on both steps', async () => {
    // `entityId` is required by `enqueue_deep_traversal`'s own input schema
    // (`src/tools/catalog/enqueues.ts`) — omitting it is a malformed call, the
    // same "treat every action as an untrusted entry point" case a
    // hand-crafted POST could produce.
    const estimate = await estimateJobStart('enqueue_deep_traversal', { programId });
    expect(estimate.ok).toBe(false);

    const confirmed = await runConfirmedJobStart('enqueue_deep_traversal', { programId });
    expect(confirmed.ok).toBe(false);
  });

  it('runConfirmedJobStart does not require estimateJobStart to have run first (stateless, unlike the chat gate)', async () => {
    // Documented in confirm-gate-actions.ts's own "What this does NOT
    // reproduce from the chat gate": there is no frozen proposal row, so a
    // caller can skip straight to confirming. Proven here rather than only
    // asserted in prose, and cleaned up afterwards.
    const secondEntityId = 'test-confirm-gate-actions-entity-skip-estimate';
    await db
      .insert(t.entity)
      .values({ id: secondEntityId, label: 'Skip Estimate Entity', country: 'DEU' })
      .onConflictDoNothing();
    try {
      const result = await runConfirmedJobStart('enqueue_deep_traversal', {
        entityId: secondEntityId,
        programId,
      });
      expect(result.ok).toBe(true);
      if (result.ok) await db.delete(t.run).where(eq(t.run.id, result.runId));
    } finally {
      await db.delete(t.job).where(eq(t.job.subjectId, secondEntityId));
      await db.delete(t.entity).where(eq(t.entity.id, secondEntityId));
    }
  });
});

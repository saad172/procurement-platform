import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import * as t from '@/db/schema';
import { call } from '@/upstream/call';
import { UpstreamCacheMissError, UpstreamError } from '@/upstream/errors';
import type { EndpointDef, UpstreamContext } from '@/upstream/types';
import {
  START_TEST_DB_HINT,
  closeTestDb,
  getTestDb,
  testDatabaseIsUp,
  testSql,
  type TestDb,
} from '../support/test-db';

/**
 * The chokepoint (SPEC §2.4, §16.2).
 *
 * These tests assert the **order of work**, because the order is the design:
 *
 *     cache lookup → dispatch → write upstream_response + usage_event → project
 *
 * The two consequences worth proving are that a too-narrow projection is a free
 * repair (the body is already cached when projection fails), and that a
 * credential-less wrapper stops and names the key it missed rather than
 * falling through to a live call.
 *
 * A fake dispatcher stands in for the network. That is not a shortcut: the
 * point under test is `call()`'s bookkeeping, and a real call would make the
 * assertions about spend untestable.
 */

const up = await testDatabaseIsUp();

describe.skipIf(!up)(`call() (needs: ${START_TEST_DB_HINT})`, () => {
  let db: TestDb;
  let ctx: UpstreamContext;
  let runId: string;
  let dispatches = 0;

  /** A narrow projection, so we can widen it and prove the repair is free. */
  const narrow = z.object({ id: z.string() });
  const wide = z.object({ id: z.string(), extra: z.string() });

  const makeEndpoint = (projection: z.ZodType, body: unknown = { id: 'x', extra: 'y' }) =>
    ({
      source: 'sayari',
      endpoint: 'test.endpoint',
      bucket: 'entity',
      timeoutMs: 1_000,
      defaults: { limit: 10 },
      normalizeParams: (p: Record<string, unknown>) => p,
      dispatch: async () => {
        dispatches += 1;
        return { body, via: 'sdk' as const };
      },
      projection,
    }) as unknown as EndpointDef<Record<string, unknown>, unknown>;

  beforeAll(async () => {
    db = await getTestDb();
    const sql = testSql();
    await sql`DELETE FROM program WHERE name = 'call() fixture'`;
    const [program] = await sql`
      INSERT INTO program (name, importing_country, vehicle_class, sourcing_horizon)
      VALUES ('call() fixture', 'USA', 'BEV', 'FY2027') RETURNING id`;
    const [run] = await sql`
      INSERT INTO run (program_id, state, trigger) VALUES (${program!.id}, 'running', 'test')
      RETURNING id`;
    runId = run!.id;
    ctx = { db, runId, credentials: { sayariClientId: 'id', sayariClientSecret: 's', nominatimUserAgent: 'ua' } };
  });

  beforeEach(async () => {
    dispatches = 0;
    await testSql()`DELETE FROM upstream_response WHERE endpoint = 'test.endpoint'`;
    await testSql()`DELETE FROM usage_event WHERE run_id = ${runId}`;
  });

  afterAll(async () => {
    if (!up) return;
    await testSql()`DELETE FROM upstream_response WHERE endpoint = 'test.endpoint'`;
    await testSql()`DELETE FROM program WHERE name = 'call() fixture'`;
    await closeTestDb();
  });

  it('caches the body and counts the call on the first request', async () => {
    const result = await call(makeEndpoint(wide), { q: 'a' }, ctx);
    expect(result.cacheHit).toBe(false);
    expect(dispatches).toBe(1);

    const rows = await db
      .select()
      .from(t.upstreamResponse)
      .where(eq(t.upstreamResponse.endpoint, 'test.endpoint'));
    expect(rows).toHaveLength(1);
    // The defaults are stored with the params, because they were applied before
    // the hash was taken — the request is self-describing.
    expect(rows[0]!.params).toMatchObject({ q: 'a', limit: 10 });

    const usage = await db.select().from(t.usageEvent).where(eq(t.usageEvent.runId, runId));
    expect(usage).toHaveLength(1);
    expect(usage[0]!.cacheHit).toBe(false);
    expect(usage[0]!.bucket).toBe('entity');
  });

  it('serves the second request from cache without dispatching', async () => {
    await call(makeEndpoint(wide), { q: 'a' }, ctx);
    const second = await call(makeEndpoint(wide), { q: 'a' }, ctx);
    expect(second.cacheHit).toBe(true);
    expect(dispatches).toBe(1);
  });

  it('still counts a cache hit — that row is what the confirm gate reads', async () => {
    await call(makeEndpoint(wide), { q: 'a' }, ctx);
    await call(makeEndpoint(wide), { q: 'a' }, ctx);
    const usage = await db.select().from(t.usageEvent).where(eq(t.usageEvent.runId, runId));
    expect(usage).toHaveLength(2);
    expect(usage.filter((u) => u.cacheHit)).toHaveLength(1);
    // "cached — no credits, no wait" is the difference between a gate people
    // read and a gate people click through.
    expect(usage.find((u) => u.cacheHit)!.ms).toBe(0);
  });

  it('re-dispatches when refresh is set, and appends rather than overwriting', async () => {
    await call(makeEndpoint(wide), { q: 'a' }, ctx);
    await call(makeEndpoint(wide), { q: 'a' }, { ...ctx, refresh: true });
    expect(dispatches).toBe(2);
    // Append-only: a refresh must not move a body that a Trace and a Citation
    // both point at.
    const rows = await db
      .select()
      .from(t.upstreamResponse)
      .where(eq(t.upstreamResponse.endpoint, 'test.endpoint'));
    expect(rows).toHaveLength(2);
  });

  describe('caching before projecting makes a too-narrow schema a free repair', () => {
    it('caches the body even when the projection then fails', async () => {
      await expect(call(makeEndpoint(narrow.strict()), { q: 'a' }, ctx)).rejects.toThrow(
        UpstreamError,
      );
      // The call spent a credit and the body is on disk. That is the whole
      // point of the ordering.
      const rows = await db
        .select()
        .from(t.upstreamResponse)
        .where(eq(t.upstreamResponse.endpoint, 'test.endpoint'));
      expect(rows).toHaveLength(1);
    });

    it('re-derives from the cached body once the projection is widened — no re-spend', async () => {
      await expect(call(makeEndpoint(narrow.strict()), { q: 'a' }, ctx)).rejects.toThrow();
      expect(dispatches).toBe(1);

      const repaired = await call(makeEndpoint(wide), { q: 'a' }, ctx);
      expect(repaired.data).toEqual({ id: 'x', extra: 'y' });
      expect(repaired.cacheHit).toBe(true);
      expect(dispatches).toBe(1); // still one — the repair cost nothing
    });

    it('does not double-count a projection failure as a second outbound attempt', async () => {
      await expect(call(makeEndpoint(narrow.strict()), { q: 'a' }, ctx)).rejects.toThrow();
      const usage = await db.select().from(t.usageEvent).where(eq(t.usageEvent.runId, runId));
      expect(usage).toHaveLength(1);
      expect(usage[0]!.outcome).toBe('ok');
    });
  });

  describe('a credential-less wrapper cannot fall through to a live call', () => {
    it('throws naming source, endpoint, hash and the params it looked for', async () => {
      const keyless: UpstreamContext = { db, runId };
      await expect(call(makeEndpoint(wide), { q: 'never-fetched' }, keyless)).rejects.toThrow(
        UpstreamCacheMissError,
      );
      await expect(call(makeEndpoint(wide), { q: 'never-fetched' }, keyless)).rejects.toThrow(
        /params_hash:[\s\S]*params:[\s\S]*never-fetched/,
      );
      expect(dispatches).toBe(0);
    });

    it('reads a cached body happily, which is what makes replay keyless by construction', async () => {
      await call(makeEndpoint(wide), { q: 'recorded' }, ctx);
      const keyless: UpstreamContext = { db, runId };
      const replayed = await call(makeEndpoint(wide), { q: 'recorded' }, keyless);
      expect(replayed.cacheHit).toBe(true);
      expect(replayed.data).toEqual({ id: 'x', extra: 'y' });
    });
  });

  describe('errors', () => {
    it('counts a failed attempt and classifies it', async () => {
      const failing = {
        ...makeEndpoint(wide),
        dispatch: async () => {
          dispatches += 1;
          throw Object.assign(new Error('nope'), { statusCode: 403 });
        },
      } as unknown as EndpointDef<Record<string, unknown>, unknown>;

      await expect(call(failing, { q: 'a' }, ctx)).rejects.toThrow(/not entitled/);
      const usage = await db.select().from(t.usageEvent).where(eq(t.usageEvent.runId, runId));
      expect(usage).toHaveLength(1);
      expect(usage[0]!.outcome).toBe('error');
      expect(usage[0]!.errorKind).toBe('entitlement');
      // A 403 is not something a second request fixes; retrying spends twice
      // for nothing.
      expect(dispatches).toBe(1);
    });

    it('retries a retryable kind exactly once more, counting each attempt', async () => {
      let calls = 0;
      const flaky = {
        ...makeEndpoint(wide),
        dispatch: async () => {
          calls += 1;
          if (calls === 1) throw Object.assign(new Error('slow down'), { statusCode: 429 });
          return { body: { id: 'x', extra: 'y' }, via: 'sdk' as const };
        },
      } as unknown as EndpointDef<Record<string, unknown>, unknown>;

      const result = await call(flaky, { q: 'a' }, ctx);
      expect(result.cacheHit).toBe(false);
      expect(calls).toBe(2);
      // One usage_event per OUTBOUND ATTEMPT, not per call. This is why the SDK
      // runs with maxRetries: 0 — an internal retry would have hidden one here.
      const usage = await db
        .select()
        .from(t.usageEvent)
        .where(and(eq(t.usageEvent.runId, runId), eq(t.usageEvent.endpoint, 'test.endpoint')));
      expect(usage).toHaveLength(2);
      expect(usage.filter((u) => u.outcome === 'error')).toHaveLength(1);
      expect(usage.filter((u) => u.outcome === 'ok')).toHaveLength(1);
    });
  });
});

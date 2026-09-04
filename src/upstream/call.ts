import { and, desc, eq, sql } from 'drizzle-orm';
import * as t from '@/db/schema';
import { classify } from './classify';
import {
  UpstreamCacheMissError,
  UpstreamCapExceededError,
  UpstreamError,
  UpstreamPersistError,
} from './errors';
import { canonicalParams, hashBody, hashParams } from './hash';
import { withRateLimit } from './rate-limit';
import type { EndpointDef, UpstreamContext, UpstreamResult } from './types';

/**
 * **The chokepoint** (SPEC §2.4, §16.2).
 *
 * Every outbound request in this application goes through this one function.
 * An ESLint import boundary makes that structural rather than conventional:
 * only `src/upstream/**` may import `@sayari/sdk` or call `fetch`, so a caller
 * that spends an upstream credit without caching it is unrepresentable.
 *
 * **The order of work IS the design:**
 *
 *     cache lookup → dispatch → write upstream_response + usage_event → project
 *
 * Caching *before* projecting is what makes a too-narrow schema a **free
 * repair**: widen the zod projection and re-derive from the cached body, with
 * no re-spend. Projecting first would have made every schema widening cost
 * another call — and on a 50-Supplier roster that is the difference between
 * fixing a field and re-running the day.
 */

const MAX_ATTEMPTS = 2;
const RETRY_AFTER_CAP_MS = 30_000;

/** Kinds worth a second attempt. Everything else fails on the first. */
const RETRYABLE = new Set(['rate_limit', 'timeout', 'transport', 'upstream_5xx']);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `Retry-After` on a 429, capped at 30 s — a correctness win the SDK discarded,
 * cheap to reclaim now that the retry is ours (SPEC §16.4).
 */
function retryDelayMs(error: unknown, attempt: number): number {
  const header =
    typeof error === 'object' && error !== null
      ? ((error as { retryAfter?: unknown; headers?: Record<string, string> }).retryAfter ??
        (error as { headers?: Record<string, string> }).headers?.['retry-after'])
      : undefined;
  const seconds =
    typeof header === 'string' ? Number(header) : typeof header === 'number' ? header : NaN;
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1_000, RETRY_AFTER_CAP_MS);
  }
  return Math.min(500 * 2 ** attempt, RETRY_AFTER_CAP_MS);
}

/**
 * Latest-wins on read over an append-only table (SPEC §3.2).
 *
 * **`id` is the tiebreak, and it is not decoration.** `fetchedAt` alone is not
 * a total order here: `seedUpstream` writes a fixture's rows in one statement,
 * so every one of them carries the same instant, and two seedings of the same
 * `paramsHash` would leave `limit(1)` answering whichever row Postgres reached
 * — an answer that changes with the plan and reads as fixture drift when it
 * moves. No committed fixture holds a duplicated key today; the point is that
 * nothing stops one from doing so, and finding 100 is what that costs.
 */
async function readCache(
  ctx: UpstreamContext,
  source: string,
  endpoint: string,
  paramsHash: string,
) {
  const [row] = await ctx.db
    .select()
    .from(t.upstreamResponse)
    .where(
      and(
        eq(t.upstreamResponse.source, source as never),
        eq(t.upstreamResponse.endpoint, endpoint),
        eq(t.upstreamResponse.paramsHash, paramsHash),
      ),
    )
    .orderBy(desc(t.upstreamResponse.fetchedAt), desc(t.upstreamResponse.id))
    .limit(1);
  return row;
}

/** One row per **outbound attempt** — not per call, and not per retry chain. */
async function writeUsage(
  ctx: UpstreamContext,
  def: { source: string; endpoint: string; bucket?: string | undefined },
  row: {
    ms: number;
    outcome: 'ok' | 'error';
    cacheHit: boolean;
    via?: 'sdk' | 'raw' | undefined;
    errorKind?: string | undefined;
    /** The body this call read or wrote; null when it failed before one existed. */
    upstreamResponseId?: string | undefined;
  },
): Promise<void> {
  await ctx.db.insert(t.usageEvent).values({
    runId: ctx.runId,
    jobId: ctx.jobId ?? null,
    source: def.source as never,
    endpoint: def.endpoint,
    bucket: def.bucket ?? null,
    via: (row.via ?? null) as never,
    ms: row.ms,
    outcome: row.outcome,
    errorKind: (row.errorKind ?? null) as never,
    cacheHit: row.cacheHit,
    upstreamResponseId: row.upstreamResponseId ?? null,
  });
}

/**
 * The spine. Reads top to bottom as the four phases named above: cache
 * lookup → dispatch (which itself writes and projects — see `dispatch()`
 * for why those two are not pulled out to this level).
 */
export async function call<TParams extends Record<string, unknown>, TProjected>(
  def: EndpointDef<TParams, TProjected>,
  rawParams: TParams,
  ctx: UpstreamContext,
): Promise<UpstreamResult<TProjected>> {
  // Defaults first, then normalise, then hash — in that order, so the hash is
  // taken over exactly what the server will be sent.
  const withDefaults = { ...def.defaults, ...rawParams } as TParams;
  const params = canonicalParams(def.normalizeParams(withDefaults));
  const paramsHash = hashParams(def.endpoint, params);

  // ── 1. Cache lookup ────────────────────────────────────────────────────────
  if (!ctx.refresh) {
    const hit = await lookupCache(ctx, def, paramsHash);
    if (hit) return hit;
  }

  // ── 2. Dispatch ────────────────────────────────────────────────────────────
  return dispatch(def, withDefaults, params, paramsHash, ctx);
}

/**
 * ── 1. Cache lookup ──────────────────────────────────────────────────────
 *
 * Returns `undefined` on a miss, so the spine's `if (hit)` reads as the
 * whole decision. A cache hit is still a usage row, with `cache_hit` true
 * and `ms` 0 — the confirm gate reads exactly this to say "cached — no
 * credits".
 */
async function lookupCache<TParams extends Record<string, unknown>, TProjected>(
  ctx: UpstreamContext,
  def: EndpointDef<TParams, TProjected>,
  paramsHash: string,
): Promise<UpstreamResult<TProjected> | undefined> {
  const cached = await readCache(ctx, def.source, def.endpoint, paramsHash);
  if (!cached) return undefined;
  await writeUsage(ctx, def, {
    ms: 0,
    outcome: 'ok',
    cacheHit: true,
    via: cached.via,
    // Recorded on a hit as well as a live call. A fixture has to find the
    // bodies a Job READ, and on a warm cache almost every read is a hit.
    upstreamResponseId: cached.id,
  });
  return {
    data: project(def, cached.body, paramsHash),
    cacheHit: true,
    via: cached.via,
    fetchedAt: cached.fetchedAt,
    upstreamResponseId: cached.id,
    bodyHash: cached.bodyHash,
  };
}

/**
 * ── 2. Dispatch ────────────────────────────────────────────────────────────
 *
 * The per-Job ceiling, the credentials guard, the retried live call, and
 * phases 3 (write) and 4 (project). They stay inside this one function,
 * rather than becoming further top-level calls from `call()`, because the
 * retry loop's try/finally is the thing that must not move.
 *
 * **The live call and the local write are retried on different terms, and
 * that split is deliberate.** Only the live call — `def.dispatch` inside
 * `withRateLimit` — sits in the try/catch that runs it through `classify()`
 * and `RETRYABLE`: a 429, a timeout or a 5xx genuinely is a failure of that
 * call, worth a second attempt. The write that follows a successful call
 * (`upstream_response` then `usage_event`) has its own, narrower try/catch
 * that never retries: a dropped connection, a deadlock or pool exhaustion
 * there is a failure of OUR write, not of the call, which already succeeded
 * and already spent the credit. Retrying it would repeat the live call to
 * re-fetch a result already in hand, so it throws immediately instead, as
 * `UpstreamPersistError` — a distinct type, outside the `UpstreamError`
 * union `classify()` builds, so it can never be mistaken for a retryable
 * failure of the call. `project()`, last, is reached only once the write has
 * already succeeded and needs no try of its own here: it already throws its
 * own classified `UpstreamError` (`kind: 'projection'`), not retryable and
 * already excluded from the usage double-count below, so letting it
 * propagate unmodified out of this function is the same outcome as before.
 *
 * ── The per-Job ceiling, checked before a live call ─────────────────────
 *
 * **After the cache, and deliberately.** A cache hit spends no credit, so
 * refusing one would stop a Job that was costing nothing — and replaying a
 * fixture, which is all cache hits, would hit a ceiling sized for real calls.
 * What this bounds is spend, so it sits exactly where spend begins.
 *
 * Counted from `usage_event`, the one home of usage, rather than from a
 * counter held in memory: a Job resumed after a killed worker has already
 * spent what its earlier attempt spent, and a fresh in-process count would
 * hand it the whole ceiling a second time.
 */
async function dispatch<TParams extends Record<string, unknown>, TProjected>(
  def: EndpointDef<TParams, TProjected>,
  withDefaults: TParams,
  params: Record<string, unknown>,
  paramsHash: string,
  ctx: UpstreamContext,
): Promise<UpstreamResult<TProjected>> {
  if (ctx.jobId && ctx.toolCallCap && ctx.toolCallCap > 0) {
    const [used] = (await ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(t.usageEvent)
      .where(and(eq(t.usageEvent.jobId, ctx.jobId), eq(t.usageEvent.cacheHit, false)))) as [
      { n: number },
    ];
    if ((used?.n ?? 0) >= ctx.toolCallCap) {
      throw new UpstreamCapExceededError(ctx.jobId, ctx.toolCallCap, def.endpoint);
    }
  }

  // A wrapper built without credentials cannot fall through to a live call. It
  // stops and names the key it missed — one of the two staleness mechanisms.
  if (!ctx.credentials) {
    throw new UpstreamCacheMissError({
      source: def.source,
      endpoint: def.endpoint,
      paramsHash,
      params,
    });
  }
  const credentials = ctx.credentials;

  let lastError: UpstreamError | undefined;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), def.timeoutMs);
    const startedAt = Date.now();

    try {
      // ── The live call — the only step retried, and the only step classified ──
      let body: unknown;
      let via: 'sdk' | 'raw';
      try {
        ({ body, via } = await withRateLimit(def.source, () =>
          def.dispatch(withDefaults, {
            credentials,
            signal: controller.signal,
            timeoutMs: def.timeoutMs,
          }),
        ));
      } catch (error) {
        const ms = Date.now() - startedAt;
        const classified = classify(error, {
          source: def.source,
          endpoint: def.endpoint,
          paramsHash,
        });
        await writeUsage(ctx, def, {
          ms,
          outcome: 'error',
          cacheHit: false,
          errorKind: classified.kind,
        });
        lastError = classified;

        const isLastAttempt = attempt === MAX_ATTEMPTS - 1;
        if (isLastAttempt || !RETRYABLE.has(classified.kind)) throw classified;
        await sleep(retryDelayMs(error, attempt));
        continue;
      }
      const ms = Date.now() - startedAt;

      // ── 3. Write, before projecting ──────────────────────────────────────
      const stored = await persistDispatchResult(def, params, paramsHash, ctx, { body, via, ms });

      // ── 4. Project ───────────────────────────────────────────────────────
      return {
        data: project(def, stored.body, paramsHash),
        cacheHit: false,
        via,
        fetchedAt: stored.fetchedAt,
        upstreamResponseId: stored.id,
        bodyHash: stored.bodyHash,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError ?? new Error('unreachable: retry loop exited without a result');
}

/**
 * ── 3. Write, before projecting ────────────────────────────────────────────
 *
 * Split out of `dispatch()`'s retry loop only to keep that function under the
 * lint's line cap — the split itself is not a decision, the try/catch it
 * wraps is.
 *
 * **Its own try/catch, deliberately not the live call's.** By the time this
 * runs the live call has already succeeded and already spent the credit, so a
 * failure here — a dropped connection, a deadlock, pool exhaustion under this
 * worker's own concurrency — is a local persistence problem, not an upstream
 * one. It is not classified through `classify()`/`RETRYABLE` and it is not
 * retried: retrying would dispatch a SECOND live call, spending a second
 * credit, to persist a result the first call already returned. It throws
 * `UpstreamPersistError` instead — a type outside the `UpstreamError` union
 * `classify()` builds, so it can never be read back as a retryable failure of
 * the call — and that failure ends this whole attempt immediately, the same
 * as any other unretried throw out of `dispatch()`'s loop.
 */
async function persistDispatchResult<TParams extends Record<string, unknown>, TProjected>(
  def: EndpointDef<TParams, TProjected>,
  params: Record<string, unknown>,
  paramsHash: string,
  ctx: UpstreamContext,
  dispatched: { body: unknown; via: 'sdk' | 'raw'; ms: number },
): Promise<{ id: string; fetchedAt: Date; body: unknown; bodyHash: string }> {
  const bodyHash = hashBody(dispatched.body);
  try {
    const [row] = await ctx.db
      .insert(t.upstreamResponse)
      .values({
        source: def.source,
        endpoint: def.endpoint,
        paramsHash,
        params,
        body: dispatched.body as never,
        bodyHash,
        via: dispatched.via,
      })
      // `body` comes back so phase 4 can project the STORED row rather than
      // the object that went in — see `project()` for why that matters.
      .returning({
        id: t.upstreamResponse.id,
        fetchedAt: t.upstreamResponse.fetchedAt,
        body: t.upstreamResponse.body,
      });
    const stored = row!;
    await writeUsage(ctx, def, {
      ms: dispatched.ms,
      outcome: 'ok',
      cacheHit: false,
      via: dispatched.via,
      upstreamResponseId: stored.id,
    });
    return { ...stored, bodyHash };
  } catch (error) {
    throw new UpstreamPersistError({
      source: def.source,
      endpoint: def.endpoint,
      paramsHash,
      cause: error,
    });
  }
}

/**
 * Callers never see an SDK type — only our own lenient projection.
 *
 * ## Both callers project the **stored** body, and that is not a detail
 *
 * `jsonb` does not preserve object key order: it stores keys sorted by length
 * then bytewise, so the row Postgres hands back is not the object that went in.
 * A live call used to project the body the SDK returned while a cache hit
 * projected the round-tripped one, which made **two different objects out of
 * one body** — Sayari's `risk` is a record keyed by factor and `identifiers` is
 * an array of passthrough objects, so both come out in a different order
 * depending on which side read them.
 *
 * A tool result is this projection serialised, and a request body is the tool
 * results so far. So a fixture recorded on a **cold** cache could never replay
 * from the bodies it had just recorded: `resolve/agree-r1` missed at turn 5 on
 * one entity's four identifiers and two risk factors, having replayed four
 * turns cleanly.
 *
 * Reading the row back on the live path costs one already-open round trip and
 * makes the two projections identical by construction — the same argument
 * finding 100 made for having one reader of the cache rather than two.
 * `tests/upstream/call.test.ts` asserts it over the serialised form, because
 * the two objects were always equal by value.
 */
function project<TParams extends Record<string, unknown>, TProjected>(
  def: EndpointDef<TParams, TProjected>,
  body: unknown,
  paramsHash: string,
): TProjected {
  const parsed = def.projection.safeParse(body);
  if (!parsed.success) {
    throw new UpstreamError({
      kind: 'projection',
      source: def.source,
      endpoint: def.endpoint,
      paramsHash,
      message:
        `We could not project ${def.source}'s ${def.endpoint} response into our own shape. ` +
        `The body is cached, so widening the projection re-derives it with no re-spend. ` +
        `Issues: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      cause: parsed.error,
    });
  }
  return parsed.data;
}

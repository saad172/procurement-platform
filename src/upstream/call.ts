import { and, desc, eq } from 'drizzle-orm';
import * as t from '@/db/schema';
import { classify } from './classify';
import { UpstreamCacheMissError, UpstreamError } from './errors';
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
      ? (error as { retryAfter?: unknown; headers?: Record<string, string> }).retryAfter ??
        (error as { headers?: Record<string, string> }).headers?.['retry-after']
      : undefined;
  const seconds = typeof header === 'string' ? Number(header) : typeof header === 'number' ? header : NaN;
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1_000, RETRY_AFTER_CAP_MS);
  }
  return Math.min(500 * 2 ** attempt, RETRY_AFTER_CAP_MS);
}

/** Latest-wins on read over an append-only table (SPEC §3.2). */
async function readCache(ctx: UpstreamContext, source: string, endpoint: string, paramsHash: string) {
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
    .orderBy(desc(t.upstreamResponse.fetchedAt))
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
    const cached = await readCache(ctx, def.source, def.endpoint, paramsHash);
    if (cached) {
      // A cache hit is still a usage row, with `cache_hit` true and `ms` 0 —
      // the confirm gate reads exactly this to say "cached — no credits".
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

  // ── 2. Dispatch ────────────────────────────────────────────────────────────
  let lastError: UpstreamError | undefined;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), def.timeoutMs);
    const startedAt = Date.now();

    try {
      const { body, via } = await withRateLimit(def.source, () =>
        def.dispatch(withDefaults, {
          credentials,
          signal: controller.signal,
          timeoutMs: def.timeoutMs,
        }),
      );
      const ms = Date.now() - startedAt;

      // ── 3. Write, before projecting ──────────────────────────────────────
      const bodyHash = hashBody(body);
      const [stored] = await ctx.db
        .insert(t.upstreamResponse)
        .values({
          source: def.source,
          endpoint: def.endpoint,
          paramsHash,
          params,
          body: body as never,
          bodyHash,
          via,
        })
        .returning({ id: t.upstreamResponse.id, fetchedAt: t.upstreamResponse.fetchedAt });
      await writeUsage(ctx, def, {
        ms,
        outcome: 'ok',
        cacheHit: false,
        via,
        upstreamResponseId: stored!.id,
      });

      // ── 4. Project ───────────────────────────────────────────────────────
      return {
        data: project(def, body, paramsHash),
        cacheHit: false,
        via,
        fetchedAt: stored!.fetchedAt,
        upstreamResponseId: stored!.id,
        bodyHash,
      };
    } catch (error) {
      const ms = Date.now() - startedAt;
      const classified = classify(error, {
        source: def.source,
        endpoint: def.endpoint,
        paramsHash,
      });
      // A projection failure happened after the body was already cached and
      // counted; re-counting it would double the usage row for one call.
      if (classified.kind !== 'projection') {
        await writeUsage(ctx, def, {
          ms,
          outcome: 'error',
          cacheHit: false,
          errorKind: classified.kind,
        });
      }
      lastError = classified;

      const isLastAttempt = attempt === MAX_ATTEMPTS - 1;
      if (isLastAttempt || !RETRYABLE.has(classified.kind)) throw classified;
      await sleep(retryDelayMs(error, attempt));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError ?? new Error('unreachable: retry loop exited without a result');
}

/** Callers never see an SDK type — only our own lenient projection. */
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

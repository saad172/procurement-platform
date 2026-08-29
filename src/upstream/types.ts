import type { z } from 'zod';
import type { Database } from '@/db/client';
import type { upstreamSource, upstreamVia } from '@/db/schema';

export type UpstreamSource = (typeof upstreamSource.enumValues)[number];
export type UpstreamVia = (typeof upstreamVia.enumValues)[number];

/**
 * Credentials are a **constructor argument**, never an environment mode
 * (SPEC §4.2, §19.1).
 *
 * A wrapper built without them is what the replay suite uses: it reads the
 * cache and throws by name on a miss, keyless by construction. There is
 * deliberately no `UPSTREAM=live|cache` flag the running app could honour —
 * that would be a second way for production to be in test mode.
 */
export type UpstreamCredentials = {
  sayariClientId: string;
  sayariClientSecret: string;
  nominatimUserAgent: string;
};

/**
 * Built by the adapter, never imported by a handler (SPEC §15.1).
 *
 * The worker is one process that would otherwise need both a pooled and a
 * direct connection at import time, so import-time env reading breaks outright.
 */
export type UpstreamContext = {
  db: Database;
  /** Every amount spent belongs to exactly one Run, with no orphan path. */
  runId: string;
  jobId?: string | undefined;
  /**
   * A **Job-level flag** carried by the three explicit acts that exist —
   * re-run resolve, re-enrich, Deep Traversal re-run — and never by a page read
   * or by chat's confirm-gated lookup, which is what lets the gate honestly say
   * *cached — no credits* (SPEC §16.5).
   */
  refresh?: boolean | undefined;
  credentials?: UpstreamCredentials | undefined;
};

/**
 * One row of the declared endpoint table (SPEC §16.2).
 *
 * Declaring endpoints as data rather than as methods is what lets `call()` be
 * the only place that touches the network: adding a source is adding a row, and
 * a row cannot forget to write its cache entry.
 */
export type EndpointDef<TParams extends Record<string, unknown>, TProjected> = {
  source: UpstreamSource;
  /** Stable name; part of the cache key, so renaming one is a cache flush. */
  endpoint: string;
  /**
   * Sayari's own endpoint-class bucket, for reconciling our count against
   * `info.getUsage()`. `negativeNews` has no bucket there at all, which is why
   * this is optional and why the UI carries a footnote saying so.
   */
  bucket?: string;
  /**
   * Applied **before** hashing. Explicit-at-default is not a no-op: it makes
   * the request self-describing and puts the numbers inside `params_hash`, so a
   * server-side default change becomes a visible difference rather than a
   * silently different body under an unchanged key (SPEC §16.6).
   */
  defaults: Partial<TParams>;
  /** Canonical form of the params, as stored and hashed. */
  normalizeParams: (params: TParams) => Record<string, unknown>;
  timeoutMs: number;
  /** The live call. Returns the raw body and which path produced it. */
  dispatch: (
    params: TParams,
    deps: DispatchDeps,
  ) => Promise<{ body: unknown; via: UpstreamVia }>;
  /**
   * Our own **lenient** zod projection, identical on both the SDK and raw
   * paths, so a caller never sees an SDK type. Lenient because the projection
   * runs *after* the cache write: a too-narrow schema is then a free repair,
   * re-derived from the cached body with no re-spend.
   */
  projection: z.ZodType<TProjected>;
};

export type DispatchDeps = {
  credentials: UpstreamCredentials;
  signal: AbortSignal;
  timeoutMs: number;
};

/** What `call()` hands back: the projection, plus how it was obtained. */
export type UpstreamResult<T> = {
  data: T;
  cacheHit: boolean;
  via: UpstreamVia;
  fetchedAt: Date;
  /** The `upstream_response` row, so an Enrichment can point at it. */
  upstreamResponseId: string;
  bodyHash: string;
};

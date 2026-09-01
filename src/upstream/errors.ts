import type { upstreamErrorKind } from '@/db/schema';

/**
 * The closed error union (SPEC §16.3).
 *
 * Ten kinds, built by one `classify()`. The union exists so that one sentence
 * can be true of the whole upstream layer:
 *
 *   > **An objection is something the model could act on; a throw is something
 *   > only we can fix.**
 *
 * Of the ten, **only `not_found` is an objection**. Every other kind throws.
 * That mapping is what stops a tool handler quietly returning
 * `{ok: false, objections: ['the API was rate limited']}` and letting a model
 * spend a Round arguing with a 429.
 */
export type UpstreamErrorKind = (typeof upstreamErrorKind.enumValues)[number];

/** The single kind a tool handler may turn into an objection. */
export const OBJECTIONABLE_KINDS = new Set<UpstreamErrorKind>(['not_found']);

export class UpstreamError extends Error {
  readonly kind: UpstreamErrorKind;
  readonly source: string;
  readonly endpoint: string;
  readonly statusCode: number | undefined;
  readonly paramsHash: string | undefined;
  override readonly cause: unknown;

  constructor(init: {
    kind: UpstreamErrorKind;
    source: string;
    endpoint: string;
    message: string;
    statusCode?: number;
    paramsHash?: string;
    cause?: unknown;
  }) {
    super(init.message);
    this.name = 'UpstreamError';
    this.kind = init.kind;
    this.source = init.source;
    this.endpoint = init.endpoint;
    this.statusCode = init.statusCode;
    this.paramsHash = init.paramsHash;
    this.cause = init.cause;
  }

  /** True when a tool handler may report this as an objection rather than throw. */
  get isObjection(): boolean {
    return OBJECTIONABLE_KINDS.has(this.kind);
  }
}

/**
 * A cache miss in a credential-less wrapper (SPEC §19.1).
 *
 * Distinct from `UpstreamError` because it is not an upstream failure at all —
 * it is a *test* telling you the request changed. It names source, endpoint,
 * hash **and the stored canonical params**, because "which key did I miss" is
 * the only question worth answering here, and one of the two staleness
 * mechanisms depends on this being loud.
 */
export class UpstreamCacheMissError extends Error {
  constructor(init: { source: string; endpoint: string; paramsHash: string; params: unknown }) {
    super(
      [
        `No cached ${init.source} response for ${init.endpoint}.`,
        `  params_hash: ${init.paramsHash}`,
        `  params:      ${JSON.stringify(init.params)}`,
        '',
        'This wrapper has no credentials, so it cannot fall through to a live call.',
        'Either the request shape changed since the fixture was recorded, or the',
        'fixture needs re-recording: pnpm fixtures:record -- <name>',
      ].join('\n'),
    );
    this.name = 'UpstreamCacheMissError';
  }
}

/**
 * A Job reached its own upstream-call ceiling (SPEC §18.2, §18.3).
 *
 * **`terminated`, never `failed`** — it names a number somebody set, so the
 * Job is re-runnable and the row is amber rather than red.
 *
 * This ceiling used to be enforced nowhere for a deterministic Job. The counts
 * live inside `runLoop`, and `enrich` never calls it, so `JOB_CAPS.enrich`'s
 * twenty-five was a number the Run page printed and nothing checked — every
 * enrich Job displayed `0 / 25` for the whole of its life. That mattered the
 * moment a Job started fanning out over the companies it found: the Run budget
 * prices model tokens only, so upstream spend is bounded by this and by nothing
 * else in the system.
 */
export class UpstreamCapExceededError extends Error {
  constructor(
    readonly jobId: string,
    readonly cap: number,
    readonly endpoint: string,
  ) {
    super(`stopped at its ${cap}-upstream-call ceiling, reaching for ${endpoint}`);
    this.name = 'UpstreamCapExceededError';
  }
}

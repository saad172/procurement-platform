import { UpstreamError, type UpstreamErrorKind } from './errors';

/**
 * One `classify()` for all five sources (SPEC §16.3).
 *
 * Two things here are load-bearing and neither is obvious:
 *
 * 1. **There is no 403 error class in the Sayari SDK.** An entitlement refusal
 *    arrives as a bare `SayariError` with `statusCode: 403`, so entitlement has
 *    to be recognised from the status code rather than from a type.
 *
 * 2. **`ParseError` is duck-typed**, not deep-imported. Reaching into the SDK's
 *    error module for one string comparison buys a dependency on unversioned
 *    surface area; a `name` plus an `errors` array is enough to recognise it and
 *    survives an SDK reshuffle.
 *
 * And one rule the messages enforce:
 *
 *   **A parse bug must never read as "not entitled".** They are opposite
 *   diagnoses — one means our client could not read a response the API
 *   successfully returned, the other means the API refused us — and confusing
 *   them sends someone to the wrong team.
 */

/** Shape-checks the SDK's ParseError without importing it. */
function isParseError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { name?: unknown; errors?: unknown };
  return candidate.name === 'ParseError' && Array.isArray(candidate.errors);
}

/** The request-side sibling of ParseError. See classify() for why they differ. */
function isJsonError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return (error as { name?: unknown }).name === 'JsonError';
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = error as { statusCode?: unknown; status?: unknown };
  const raw = candidate.statusCode ?? candidate.status;
  return typeof raw === 'number' ? raw : undefined;
}

function kindFromStatus(status: number): UpstreamErrorKind {
  if (status === 401) return 'auth';
  if (status === 403) return 'entitlement';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'upstream_5xx';
  if (status >= 400) return 'bad_request';
  return 'transport';
}

function messageFor(kind: UpstreamErrorKind, source: string, endpoint: string, detail: string) {
  switch (kind) {
    case 'parse':
      // Deliberately never the same sentence as `entitlement`.
      return `Our ${source} client could not read the response for ${endpoint} (SDK parse bug) — the call itself succeeded. ${detail}`;
    case 'entitlement':
      return `${source} refused this call: not entitled (403) for ${endpoint}. ${detail}`;
    case 'auth':
      return `${source} rejected our credentials (401) for ${endpoint}. ${detail}`;
    case 'rate_limit':
      return `${source} rate-limited ${endpoint} (429). ${detail}`;
    case 'not_found':
      return `${source} has no ${endpoint} result for these parameters (404). ${detail}`;
    case 'bad_request':
      return `${source} rejected our ${endpoint} request as malformed. ${detail}`;
    case 'timeout':
      return `${source} did not answer ${endpoint} within its timeout. ${detail}`;
    case 'upstream_5xx':
      return `${source} failed on ${endpoint} (server error). ${detail}`;
    case 'projection':
      return `We could not project ${source}'s ${endpoint} response into our own shape. ${detail}`;
    case 'transport':
      return `Could not reach ${source} for ${endpoint}. ${detail}`;
  }
}

export function classify(
  error: unknown,
  context: { source: string; endpoint: string; paramsHash?: string },
): UpstreamError {
  if (error instanceof UpstreamError) return error;

  const detail = error instanceof Error ? error.message : String(error);
  const status = statusOf(error);

  let kind: UpstreamErrorKind;
  if (isParseError(error)) {
    kind = 'parse';
  } else if (isJsonError(error)) {
    // The SDK's `JsonError` is the mirror image of `ParseError`: it means the
    // SDK could not serialise OUR request, not that it could not read THEIR
    // response. That is our bug, so it is `bad_request` and it does not trigger
    // the raw fallback — re-issuing a malformed request would spend a second
    // credit to fail the same way.
    kind = 'bad_request';
  } else if (error instanceof Error && error.name === 'ZodError') {
    kind = 'projection';
  } else if (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError' || /timeout/i.test(error.message))
  ) {
    kind = 'timeout';
  } else if (status !== undefined) {
    kind = kindFromStatus(status);
  } else {
    kind = 'transport';
  }

  return new UpstreamError({
    kind,
    source: context.source,
    endpoint: context.endpoint,
    message: messageFor(kind, context.source, context.endpoint, detail),
    ...(status !== undefined ? { statusCode: status } : {}),
    ...(context.paramsHash !== undefined ? { paramsHash: context.paramsHash } : {}),
    cause: error,
  });
}

import {
  APIConnectionError,
  APIError,
  AuthenticationError,
  BadRequestError,
  PermissionDeniedError,
  RateLimitError,
} from '@anthropic-ai/sdk';
import { describeError } from '@/lib/describe-error';

/**
 * What actually went wrong with a model call, in one sentence a person can act
 * on (SPEC §17.5, §18.4) — companion to `describeError` for the one error shape
 * that library does not know about.
 *
 * The bug this exists for reached the chat dock as:
 *
 * > `That did not work: {"type":"error","error":{"type":"overloaded_error",
 * > "message":"Overloaded"},"request_id":"req_…"}`
 *
 * an Anthropic 529 that survived the SDK's `maxRetries: 2` (`settings.ts`,
 * `SDK_REQUEST_OPTIONS`). `runLoop()`'s failure path took `error.message` off
 * the caught `Error`, and for the SDK's `APIError` that message is
 * `${status} ${JSON.stringify(body)}` — the wire body, not a sentence. This
 * maps the shapes `@anthropic-ai/sdk` 0.122.0 actually throws to a plain
 * sentence instead.
 *
 * **Only `src/model/**` may import `@anthropic-ai/sdk`** (see
 * `eslint.config.mjs`), which is exactly why recognising these classes has to
 * live here rather than beside `describeError`.
 *
 * Checked **`instanceof` first**, because the SDK gives 401/403/429/400 their
 * own subclasses (`AuthenticationError`, `PermissionDeniedError`,
 * `RateLimitError`, `BadRequestError`) and `APIConnectionError` for a request
 * that never got a response at all. 529 has no subclass of its own — the SDK's
 * `APIError.generate()` buckets every `status >= 500` into
 * `InternalServerError` — so overloaded is told apart by the body's
 * `error.type`, which is why every branch below falls through to a type check
 * on a bare `APIError` as well as an `instanceof` on the named subclass.
 *
 * A **named, still-generic** Anthropic error — `not_found_error`,
 * `billing_error`, a gateway `timeout_error`, or any other plain `APIError`
 * this table does not special-case — gets its status and detail read out
 * rather than falling straight to `describeError`'s wire-body fallback,
 * which is the sentence this file exists to stop reaching the dock.
 * Everything that is not even an SDK error (a non-`APIError` throw) falls
 * back to `describeError`. `src/lib` is a leaf module — `src/model/wire.ts`
 * already imports `canonical-json` from it — so the edge this file adds
 * (`src/model` → `src/lib/describe-error`) closes no cycle.
 */

/** The API's own nested `error.message`, the one field that names the bad field. */
function apiBodyMessage(error: APIError): string | undefined {
  const body = error.error as { error?: { message?: unknown } } | undefined;
  const message = body?.error?.message;
  return typeof message === 'string' ? message : undefined;
}

/** 529 has no SDK subclass — `status >= 500` all become `InternalServerError`. */
function isOverloaded(error: APIError): boolean {
  return error.status === 529 || error.type === 'overloaded_error';
}

export function describeModelError(error: unknown): string {
  if (error instanceof APIConnectionError) {
    return 'could not reach the model — the request never got a response.';
  }

  if (
    error instanceof RateLimitError ||
    (error instanceof APIError && error.type === 'rate_limit_error')
  ) {
    return 'the model rate-limited this request; ask again in a moment.';
  }

  if (
    error instanceof AuthenticationError ||
    error instanceof PermissionDeniedError ||
    (error instanceof APIError &&
      (error.type === 'authentication_error' || error.type === 'permission_error'))
  ) {
    return 'the model refused our credentials — check ANTHROPIC_API_KEY.';
  }

  if (
    error instanceof BadRequestError ||
    (error instanceof APIError && error.type === 'invalid_request_error')
  ) {
    const detail = apiBodyMessage(error as APIError) ?? (error as APIError).message;
    return `the model rejected the request: ${detail}`;
  }

  if (error instanceof APIError && isOverloaded(error)) {
    return 'the model is overloaded right now; ask again in a moment.';
  }

  /**
   * Every other `APIError` this SDK version can throw — `not_found_error`,
   * `billing_error`, a gateway `timeout_error`, or a plain 500 `api_error` —
   * is still an `APIError`, so it still carries `status` and a body worth
   * reading. Falling through to `describeError` here is exactly the bug this
   * file exists for: `describeError` takes `error.message`, and for an
   * `APIError` that message is the wire body verbatim.
   */
  if (error instanceof APIError) {
    return `the model returned ${error.status}: ${apiBodyMessage(error) ?? 'no detail'}`;
  }

  return describeError(error);
}

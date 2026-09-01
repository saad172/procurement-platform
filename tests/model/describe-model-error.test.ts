import { describe, expect, it } from 'vitest';
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  AuthenticationError,
  BadRequestError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
} from '@anthropic-ai/sdk';
import { describeModelError } from '@/model/describe-model-error';

/**
 * One case per branch of `describeModelError` (SPEC §17.5, §18.4), built by
 * constructing the SDK's own error classes directly — no network, and no
 * mocking of `fetch`, because the thing under test is *which class the SDK
 * throws* against *what we say about it*, not the request that produced one.
 */

const HEADERS = new Headers();

/** The shape `APIError.generate()` hangs on `.error`: the full response body. */
function body(
  type: string,
  message: string,
): { type: string; error: { type: string; message: string }; request_id: string } {
  return { type: 'error', error: { type, message }, request_id: 'req_test' };
}

describe('describeModelError', () => {
  it('names a 529 overloaded error — the bug this file exists for', () => {
    const error = new APIError(
      529,
      body('overloaded_error', 'Overloaded'),
      undefined,
      HEADERS,
      'overloaded_error',
    );
    expect(describeModelError(error)).toBe(
      'the model is overloaded right now; ask again in a moment.',
    );
  });

  it('names a 429 rate limit', () => {
    const error = new RateLimitError(
      429,
      body('rate_limit_error', 'Number of request tokens has exceeded your rate limit'),
      undefined,
      HEADERS,
      'rate_limit_error',
    );
    expect(describeModelError(error)).toBe(
      'the model rate-limited this request; ask again in a moment.',
    );
  });

  it('names a 401 authentication failure', () => {
    const error = new AuthenticationError(
      401,
      body('authentication_error', 'invalid x-api-key'),
      undefined,
      HEADERS,
      'authentication_error',
    );
    expect(describeModelError(error)).toBe(
      'the model refused our credentials — check ANTHROPIC_API_KEY.',
    );
  });

  it('names a 403 permission failure the same way as a 401', () => {
    const error = new PermissionDeniedError(
      403,
      body('permission_error', 'Your credentials are not permitted for this resource'),
      undefined,
      HEADERS,
      'permission_error',
    );
    expect(describeModelError(error)).toBe(
      'the model refused our credentials — check ANTHROPIC_API_KEY.',
    );
  });

  it('keeps the API’s own message for a bad request, because it names the field', () => {
    const error = new BadRequestError(
      400,
      body('invalid_request_error', 'max_tokens: must be greater than 0'),
      undefined,
      HEADERS,
      'invalid_request_error',
    );
    expect(describeModelError(error)).toBe(
      'the model rejected the request: max_tokens: must be greater than 0',
    );
  });

  it('names a connection failure that never reached the model', () => {
    const error = new APIConnectionError({ message: 'fetch failed' });
    expect(describeModelError(error)).toBe(
      'could not reach the model — the request never got a response.',
    );
  });

  it('treats a timeout as the same connection failure', () => {
    const error = new APIConnectionTimeoutError();
    expect(describeModelError(error)).toBe(
      'could not reach the model — the request never got a response.',
    );
  });

  it('falls back to describeError for an SDK error this table does not name', () => {
    const error = new NotFoundError(
      404,
      body('not_found_error', 'model not found'),
      undefined,
      HEADERS,
      'not_found_error',
    );
    // No dedicated branch for `not_found_error`: describeModelError defers to
    // the cause-walking `describeError`, which — with no `.cause` to walk —
    // reports the SDK's own top-level `.message` (see `APIError.makeMessage`).
    expect(describeModelError(error)).toBe(error.message);
  });

  it('falls back to the plain message for a non-SDK error', () => {
    expect(describeModelError(new Error('boom'))).toBe('boom');
  });

  it('stringifies a thrown value that is not even an Error', () => {
    expect(describeModelError('boom')).toBe('boom');
  });
});

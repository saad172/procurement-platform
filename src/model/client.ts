import Anthropic from '@anthropic-ai/sdk';
import { SDK_REQUEST_OPTIONS } from './settings';
import type { ModelCredentials } from './types';
import { rawBodyHash, rememberWireHash, wireHash } from './wire';

/**
 * The one place an `Anthropic` client is constructed (SPEC §17.2).
 *
 * An ESLint import boundary makes that structural: only `src/model/**` may
 * import `@anthropic-ai/sdk`, so an unmetered, untraced model call is
 * unrepresentable rather than tested for.
 *
 * `withOptions` applies the SDK-level retry and timeout per loop rather than
 * globally, so the settings sit beside the table that documents them.
 */
const clients = new Map<string, Anthropic>();

/**
 * Wraps a `fetch` so every outbound body is fingerprinted and filed under the
 * id of the message it produced (see `wire.ts`).
 *
 * This is the *only* honest place to do it. The Tool Runner builds the request
 * for turns 2..n internally, so nothing above this line ever sees those bodies;
 * `fetch` sees all of them and nothing else.
 *
 * **It never changes the request, and never fails the call.** A hash is
 * bookkeeping for replay, and bookkeeping that can break a live Job is worse
 * than no bookkeeping — so the response is cloned to read it, and any error in
 * reading is swallowed. The consequence of a miss is one fixture turn that
 * cannot be replayed, which the fixture recorder reports.
 *
 * **Streaming turns are skipped, deliberately.** A streamed response is an SSE
 * body, and reading the message id out of it means draining a clone to the
 * `message_start` event — buffering a whole turn to file a number that no
 * `trace_turn` will use, since the only loop that streams is chat and chat
 * writes no Trace. Recording a streamed turn is `src/fixtures/record-fetch.ts`,
 * which is honest about buffering because that is the whole of what it does.
 */
function capturing(inner: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await inner(input, init);

    const body = init?.body;
    if (typeof body !== 'string') return response;
    if (!response.headers.get('content-type')?.includes('application/json')) return response;

    try {
      const seen = (await response.clone().json()) as { id?: unknown };
      if (typeof seen.id === 'string') {
        rememberWireHash(seen.id, { wire: wireHash(body), raw: rawBodyHash(body) });
      }
    } catch {
      // A body that is not the shape we expected: nothing to file, nothing to fix.
    }
    return response;
  };
}

/**
 * `credentials.fetch` is the replay seam (SPEC §19.1).
 *
 * Replay passes a `replayFetch` and **no usable key**, so the suite is keyless
 * by construction rather than by a mock that could be bypassed: a request that
 * escaped the seam would reach the real API with a placeholder key and fail
 * loudly, not quietly succeed.
 */
export function getAnthropicClient(credentials: ModelCredentials): Anthropic {
  // A supplied fetch belongs to one replay and must never be shared or cached.
  if (credentials.fetch) {
    return new Anthropic({
      apiKey: credentials.apiKey,
      fetch: capturing(credentials.fetch),
    }).withOptions(SDK_REQUEST_OPTIONS);
  }

  let client = clients.get(credentials.apiKey);
  if (!client) {
    client = new Anthropic({
      apiKey: credentials.apiKey,
      // The Anthropic egress point itself. The global-fetch ban exists to stop
      // an *upstream* call escaping `src/upstream/call()` uncached; this is the
      // model client that this same directory is explicitly permitted to
      // construct, and the global is wrapped rather than called directly.
      // eslint-disable-next-line no-restricted-globals
      fetch: capturing(fetch),
    }).withOptions(SDK_REQUEST_OPTIONS);
    clients.set(credentials.apiKey, client);
  }
  return client;
}

export function resetAnthropicClients(): void {
  clients.clear();
}

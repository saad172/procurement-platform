import { SayariClient, SayariEnvironment } from '@sayari/sdk';
import type { DispatchDeps, UpstreamCredentials } from '../types';

/**
 * The one place a `SayariClient` is constructed.
 *
 * The client is cached per credential pair because it holds an OAuth2 token: a
 * fresh client per request would re-authenticate on every call.
 */
const clients = new Map<string, SayariClient>();

export function getSayariClient(credentials: UpstreamCredentials): SayariClient {
  const key = credentials.sayariClientId;
  let client = clients.get(key);
  if (!client) {
    client = new SayariClient({
      clientId: credentials.sayariClientId,
      clientSecret: credentials.sayariClientSecret,
      environment: SayariEnvironment.Production,
    });
    clients.set(key, client);
  }
  return client;
}

/**
 * Per-request options for every SDK call, and the reason they are per-request
 * rather than on the client is simply that the SDK puts them there.
 *
 * `maxRetries: 0` is the load-bearing one (SPEC §16.4). SDK retries happen
 * *inside* the SDK, so a retried 429 would be one `usage_event` covering three
 * outbound requests — and the whole usage surface rests on **one outbound
 * attempt = one counted call**. The retry moves into `call()` instead, where it
 * can be counted, and where `Retry-After` can be honoured (the SDK discards it).
 *
 * The timeout is passed too, so the SDK gives up at the same moment our own
 * AbortController does rather than a moment after.
 */
export function requestOptions(deps: DispatchDeps): {
  maxRetries: number;
  timeoutInSeconds: number;
  abortSignal: AbortSignal;
} {
  return {
    maxRetries: 0,
    timeoutInSeconds: Math.ceil(deps.timeoutMs / 1_000),
    abortSignal: deps.signal,
  };
}

/** Test seam, and a way to force re-authentication after a credential change. */
export function resetSayariClients(): void {
  clients.clear();
}

export const SAYARI_BASE_URL = SayariEnvironment.Production;

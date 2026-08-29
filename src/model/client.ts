import Anthropic from '@anthropic-ai/sdk';
import { SDK_REQUEST_OPTIONS } from './settings';
import type { ModelCredentials } from './types';

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

export function getAnthropicClient(credentials: ModelCredentials): Anthropic {
  let client = clients.get(credentials.apiKey);
  if (!client) {
    client = new Anthropic({ apiKey: credentials.apiKey }).withOptions(SDK_REQUEST_OPTIONS);
    clients.set(credentials.apiKey, client);
  }
  return client;
}

export function resetAnthropicClients(): void {
  clients.clear();
}

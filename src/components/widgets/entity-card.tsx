import { RawPayload } from './raw';

/** `entity_card` — not yet drawn; the frozen payload stands in until it is. */
export function EntityCardWidget({ payload }: { payload: unknown }) {
  return <RawPayload payload={payload} />;
}

import { RawPayload } from './raw';

/** `record_card` — not yet drawn; the frozen payload stands in until it is. */
export function RecordCardWidget({ payload }: { payload: unknown }) {
  return <RawPayload payload={payload} />;
}

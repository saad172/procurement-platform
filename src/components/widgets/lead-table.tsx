import { RawPayload } from './raw';

/** `lead_table` — not yet drawn; the frozen payload stands in until it is. */
export function LeadTableWidget({ payload }: { payload: unknown }) {
  return <RawPayload payload={payload} />;
}

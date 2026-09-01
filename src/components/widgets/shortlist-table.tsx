import { RawPayload } from './raw';

/** `shortlist_table` — not yet drawn; the frozen payload stands in until it is. */
export function ShortlistTableWidget({ payload }: { payload: unknown }) {
  return <RawPayload payload={payload} />;
}

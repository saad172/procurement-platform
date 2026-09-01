import { RawPayload } from './raw';

/** `source_result` — not yet drawn; the frozen payload stands in until it is. */
export function SourceResultWidget({ payload }: { payload: unknown }) {
  return <RawPayload payload={payload} />;
}

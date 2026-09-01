import { RawPayload } from './raw';

/** `trace_timeline` — not yet drawn; the frozen payload stands in until it is. */
export function TraceTimelineWidget({ payload }: { payload: unknown }) {
  return <RawPayload payload={payload} />;
}

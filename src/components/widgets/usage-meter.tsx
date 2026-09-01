import { RawPayload } from './raw';

/** `usage_meter` — not yet drawn; the frozen payload stands in until it is. */
export function UsageMeterWidget({ payload }: { payload: unknown }) {
  return <RawPayload payload={payload} />;
}

import { RawPayload } from './raw';

/** `criterion_compare` — not yet drawn; the frozen payload stands in until it is. */
export function CriterionCompareWidget({ payload }: { payload: unknown }) {
  return <RawPayload payload={payload} />;
}

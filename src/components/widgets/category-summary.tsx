import { RawPayload } from './raw';

/** `category_summary` — not yet drawn; the frozen payload stands in until it is. */
export function CategorySummaryWidget({ payload }: { payload: unknown }) {
  return <RawPayload payload={payload} />;
}

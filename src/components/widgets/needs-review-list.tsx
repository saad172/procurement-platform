import { RawPayload } from './raw';

/** `needs_review_list` — not yet drawn; the frozen payload stands in until it is. */
export function NeedsReviewListWidget({ payload }: { payload: unknown }) {
  return <RawPayload payload={payload} />;
}

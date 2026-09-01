import { RawPayload } from './raw';

/** `program_summary` — not yet drawn; the frozen payload stands in until it is. */
export function ProgramSummaryWidget({ payload }: { payload: unknown }) {
  return <RawPayload payload={payload} />;
}

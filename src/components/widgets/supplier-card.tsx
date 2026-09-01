import { RawPayload } from './raw';

/** `supplier_card` — not yet drawn; the frozen payload stands in until it is. */
export function SupplierCardWidget({ payload }: { payload: unknown }) {
  return <RawPayload payload={payload} />;
}

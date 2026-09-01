import { RawPayload } from './raw';

/** `supplier_family` — not yet drawn; the frozen payload stands in until it is. */
export function SupplierFamilyWidget({ payload }: { payload: unknown }) {
  return <RawPayload payload={payload} />;
}

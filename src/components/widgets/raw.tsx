/**
 * The frozen payload, shown whole.
 *
 * Every widget renderer falls back to this when the payload is not the shape
 * it expects — a widget frozen onto a message months ago outlives the
 * renderer written for it, and the record must stay readable. It is also what
 * sits under every rendered widget's chip, because the working is demoted,
 * never hidden. Never sliced mid-object: a JSON dump that ends in
 * `"source_type": "company_data` is worse than a long one.
 */
export function RawPayload({ payload }: { payload: unknown }) {
  return (
    <pre
      className="mono"
      style={{ margin: '0.4rem 0 0', whiteSpace: 'pre-wrap', maxHeight: '18rem', overflow: 'auto' }}
    >
      {JSON.stringify(payload, null, 2)}
    </pre>
  );
}

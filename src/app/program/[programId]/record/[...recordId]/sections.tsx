import type { loadRecordPage } from '@/db/queries/record-page';

/**
 * The Record page's one section (SPEC §13.1). A one-`<h2>` page still gets a
 * `sections.tsx` with one component, applied uniformly with every other page.
 */
type Data = NonNullable<Awaited<ReturnType<typeof loadRecordPage>>>;

/** ── Fields, as the source recorded them ── */
export function Fields({ data }: { data: Data }) {
  const { record } = data;
  if (!record.fields) return null;
  return (
    <>
      <h2>Fields, as the source recorded them</h2>
      <div className="card scroll-x">
        <pre className="mono" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
          {JSON.stringify(record.fields, null, 2)}
        </pre>
      </div>
    </>
  );
}

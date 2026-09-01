import { RawPayload } from './raw';
import { isoDate, isObj, str } from './parts-card';

/**
 * `record_card` — mirrors the Record page's one field table plus its `Fields`
 * section (`src/app/program/[programId]/record/[...recordId]/{page,sections}.tsx`),
 * the bottom of a Citation hop.
 *
 * `get_record`'s payload is the raw `record` row (SPEC §3.2). **No link**: a
 * record id is a path (`source/{record}/timestamp`) and the page needs a
 * `programId` ahead of it — neither is on this row, so nothing is guessed.
 */
export function RecordCardWidget({ payload }: { payload: unknown }) {
  const r = parse(payload);
  if (!r) return <RawPayload payload={payload} />;
  return (
    <div>
      <h4 style={{ margin: '0 0 0.2rem' }}>{r.sourceLabel ?? r.source ?? 'Source record'}</h4>
      <p className="sub mono" style={{ margin: '0 0 0.5rem' }}>
        {r.id}
      </p>
      <table>
        <tbody>
          <tr>
            <td>Source</td>
            <td>{r.source ?? '—'}</td>
          </tr>
          <tr>
            <td>Collected</td>
            <td>{isoDate(r.collectedAt)}</td>
          </tr>
          <tr>
            <td>Published</td>
            <td>{isoDate(r.publishedAt)}</td>
          </tr>
          <tr>
            <td>First seen here</td>
            <td>{isoDate(r.firstSeenAt)}</td>
          </tr>
        </tbody>
      </table>
      {r.fields != null ? (
        <details className="working" style={{ marginTop: '0.6rem' }}>
          <summary>Fields, as the source recorded them</summary>
          <pre className="mono" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
            {JSON.stringify(r.fields, null, 2)}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

function parse(payload: unknown) {
  if (!isObj(payload)) return null;
  const id = str(payload.id);
  if (!id) return null;
  return {
    id,
    source: str(payload.source),
    sourceLabel: str(payload.sourceLabel),
    collectedAt: payload.collectedAt,
    publishedAt: payload.publishedAt,
    firstSeenAt: payload.firstSeenAt,
    fields: 'fields' in payload ? payload.fields : null,
  };
}

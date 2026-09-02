import { RawPayload } from './raw';
import { isoDate, isObj, str } from './narrow';

/**
 * `record_card` — the Record page's own answer strip
 * (`src/app/program/[programId]/record/[...recordId]/page.tsx`, the `<h1>`/
 * `<table>` above its one section) plus `Fields`' collapsed JSON
 * (`sections.tsx`) — **level five, the bottom of a Citation hop** and of the
 * spine `Program → Category → Supplier → Sayari entity → record` (SPEC
 * §13.1).
 *
 * `get_record`'s payload is the raw `record` row (SPEC §3.2). **No link**: a
 * record id is a three-part path — `source/{record}/timestamp` — and the
 * page's `[...recordId]` catch-all also needs a `programId` ahead of it;
 * neither travels with this row, so nothing is guessed at a wrong Program.
 */
export function RecordCardWidget({ payload }: { payload: unknown }) {
  const r = parse(payload);
  // Falls back rather than throws: a widget frozen onto a message outlives
  // the shape `parse()` expects (finding 103).
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
            {/*
              Never re-stamped on refresh, on the page this mirrors: the
              *new evidence* staleness chip is computed from firstSeenAt,
              and re-stamping it here would be a second clock disagreeing.
            */}
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

/** Every field optional-checked by hand: this payload is the raw `record` row, not a declared schema. */
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
    // `'fields' in payload` rather than `payload.fields != null`, because a
    // source record with genuinely no fields and one whose key was dropped
    // before freezing render the same otherwise — the details block is
    // about whether there is anything to expand, not what is inside it.
    fields: 'fields' in payload ? payload.fields : null,
  };
}

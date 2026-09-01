import { RawPayload } from './raw';
import { arr, isObj, str } from './parts-card';

/**
 * `source_result` — the one widget shared by all nine chat-reachable raw
 * lookups (SPEC §14.4, `src/tools/catalog/lookups.ts` `sourceResult()`).
 *
 * **The cache-hit line is the point of this type**: it is what lets the
 * confirm gate's *"cached — no credits, no wait"* be checked after the fact,
 * against the same field. Below it, a best-effort common view of the inner
 * `payload` — nine different upstream shapes, so only what most of them share
 * (a label, an id, a country, a result count) is drawn; the rest stays in the
 * chip.
 */
export function SourceResultWidget({ payload }: { payload: unknown }) {
  const r = parse(payload);
  if (!r) return <RawPayload payload={payload} />;
  const items = summarize(r.payload);
  return (
    <div>
      <p style={{ margin: 0 }}>
        <b>{r.source}</b>{' '}
        {r.cacheHit ? (
          <span className="badge good">{r.cachedNote ?? 'cached'}</span>
        ) : (
          <span className="badge mute">live call</span>
        )}
      </p>
      {items.count != null ? (
        <p className="note" style={{ margin: '0.3rem 0 0' }}>
          {items.count} result{items.count === 1 ? '' : 's'}
        </p>
      ) : null}
      {items.rows.length > 0 ? (
        <table style={{ marginTop: '0.3rem' }}>
          <tbody>
            {items.rows.map((row, i) => (
              <tr key={i}>
                <td>{row.label ?? '—'}</td>
                <td className="mono note">{row.id ?? ''}</td>
                <td className="note">{row.country ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

const LABEL_PATHS = [
  ['label'],
  ['name'],
  ['resolvedLegalName'],
  ['legalName', 'name'],
  ['htsno'],
  ['display_name'],
  ['attributes', 'entity', 'legalName', 'name'],
];
const ID_PATHS = [['id'], ['entityId'], ['entity_id'], ['lei'], ['hsCode'], ['place_id']];
const COUNTRY_PATHS = [
  ['country'],
  ['countryCode'],
  ['country_iso3'],
  ['legalAddress', 'country'],
  ['attributes', 'entity', 'legalAddress', 'country'],
];

function summarize(inner: unknown): {
  count: number | null;
  rows: { label: string | null; id: string | null; country: string | null }[];
} {
  if (Array.isArray(inner)) {
    return { count: inner.length, rows: inner.slice(0, 3).map(oneRow) };
  }
  if (isObj(inner)) {
    // A single object is one thing, not a collection — there is no count to show.
    const row = oneRow(inner);
    return { count: null, rows: row.label || row.id || row.country ? [row] : [] };
  }
  return { count: null, rows: [] };
}

function oneRow(item: unknown): {
  label: string | null;
  id: string | null;
  country: string | null;
} {
  return {
    label: firstOf(item, LABEL_PATHS),
    id: firstOf(item, ID_PATHS),
    country: firstOf(item, COUNTRY_PATHS),
  };
}

function firstOf(item: unknown, paths: string[][]): string | null {
  for (const path of paths) {
    let cur: unknown = item;
    for (const key of path) {
      cur = isObj(cur) ? cur[key] : undefined;
    }
    const s = str(cur);
    if (s) return s;
  }
  return null;
}

function parse(payload: unknown) {
  if (!isObj(payload)) return null;
  const source = str(payload.source);
  if (!source || typeof payload.cacheHit !== 'boolean') return null;
  return {
    source,
    cacheHit: payload.cacheHit,
    cachedNote: str(payload.cachedNote),
    payload: 'payload' in payload ? payload.payload : arr(payload.payload),
  };
}

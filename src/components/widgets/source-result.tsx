import { RawPayload } from './raw';
import { arr, isObj, str } from './narrow';

/**
 * `source_result` — the one widget shared by all nine chat-reachable raw
 * lookups (SPEC §14.4, `sourceResult()` in `src/tools/catalog/lookups.ts`):
 * `sayari_resolve`, `sayari_search_entity`, `sayari_get_entity`,
 * `sayari_get_record`, `gleif_join_lei`, `gleif_search_name`,
 * `worldbank_indicator`, `usitc_tariff` and `nominatim_geocode` — the tools
 * whose `surfaces` array names `chat` among this file's twelve `sourceResult`
 * callers; `sayari_traversal`, `sayari_negative_news` and
 * `sayari_trade_search` share the widget type but run only from a Job or
 * MCP. None of the nine has a page of its own to mirror — a raw lookup is a
 * lower-level read than anything a page shows — so this widget's job is
 * reading nine different upstream shapes into one legible card rather than
 * mirroring a section.
 *
 * **The cache-hit line is the point of this type**: `cachedNote` carries the
 * confirm gate's own words, `cached — no credits, no wait`, so a person can
 * check after the fact that a call the gate promised would cost nothing
 * actually did not run. Below it, a best-effort common view of the inner
 * `payload` — nine shapes with almost nothing in common structurally, so
 * only what most of them happen to share (a label, an id, a country, a
 * result count) is drawn; everything upstream-specific stays in the chip.
 */
export function SourceResultWidget({ payload }: { payload: unknown }) {
  const r = parse(payload);
  // Falls back rather than throws: a widget frozen onto a message outlives
  // the shape `parse()` expects (finding 103).
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

/**
 * ── The nine shapes' label field, in the order tried ──
 *
 * `label` covers `sayari_resolve`; `htsno` is USITC's own tariff-line-code
 * field name, kept as-is by the upstream projection (`upstream/projections/
 * external.ts`); `display_name` is Nominatim's, same reason; the last path
 * is GLEIF's own JSON:API nesting, `gleifRecord.attributes.entity.legalName.
 * name` in that same projection file — `gleif_join_lei` and `gleif_search_
 * name` freeze that record whole rather than flatten it, unlike the
 * resolve-loop's own GLEIF tools, which project the same fields flat.
 *
 * The remaining entries (`name`, `resolvedLegalName`, `legalName.name`)
 * were written for shapes this file did not re-verify against the current
 * nine tools' actual response bodies — kept rather than pruned on a
 * comment-only pass, since removing one is a behaviour change this pass is
 * not making.
 */
const LABEL_PATHS = [
  ['label'],
  ['name'],
  ['resolvedLegalName'],
  ['legalName', 'name'],
  ['htsno'],
  ['display_name'],
  ['attributes', 'entity', 'legalName', 'name'],
];
/** `id` matches Sayari's rows and GLEIF's (GLEIF's own `id` **is** the LEI); the rest are the same not-re-verified caveat as `LABEL_PATHS`. */
const ID_PATHS = [['id'], ['entityId'], ['entity_id'], ['lei'], ['hsCode'], ['place_id']];
/**
 * `legalAddress.country` pairs with `LABEL_PATHS`'s GLEIF path (same
 * `gleifRecord.attributes.entity` nesting). World Bank's own field is
 * `countryiso3code`, not `country_iso3` below — a discrepancy this pass
 * found and left, per the note above `LABEL_PATHS`.
 */
const COUNTRY_PATHS = [
  ['country'],
  ['countryCode'],
  ['country_iso3'],
  ['legalAddress', 'country'],
  ['attributes', 'entity', 'legalAddress', 'country'],
];

/**
 * An array is a result set with a count; a single object is one thing with
 * none — Nominatim and a GLEIF LEI-record read both return one object, and a
 * count of "1" there would claim a result set that was never asked for.
 */
function summarize(inner: unknown): {
  count: number | null;
  rows: { label: string | null; id: string | null; country: string | null }[];
} {
  if (Array.isArray(inner)) {
    return { count: inner.length, rows: inner.slice(0, 3).map(oneRow) };
  }
  if (isObj(inner)) {
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

/** First path that resolves to a non-empty string wins — the paths are tried in the order most-common-shape-first, not merged. */
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
    // `arr()` only when `payload` is missing entirely — a payload frozen
    // before this field's own shape stabilised. When present, whatever it
    // is (object or array) passes through unchanged for `summarize()`.
    payload: 'payload' in payload ? payload.payload : arr(payload.payload),
  };
}

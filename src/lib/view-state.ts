import { DEFAULT_WEIGHTS, WEIGHTED_CRITERIA, normaliseWeights, type WeightVector } from '@/domain/score';

/**
 * View state (SPEC §13.5).
 *
 * Two sentences carry this whole module:
 *
 * > **View state lives in the URL, and a filter is presentation — never an
 * > argument.**
 *
 * The URL is why an unsaved what-if **survives a reload**, why a ranking can be
 * **shared** without silently re-ranking under the recipient's stored default,
 * why the breadcrumb contract is implementable rather than a convention, and
 * why chat needs **no `set_weights` tool** — "set compliance to 40" *is* a
 * navigation.
 */

/** The five facets. A map region preset is a **camera, not a facet**. */
export type Facets = {
  country?: string[] | undefined;
  matchStatus?: string[] | undefined;
  riskFlag?: string[] | undefined;
  scoreBand?: string[] | undefined;
  ownershipGroup?: string[] | undefined;
};

export type ViewState = {
  weights: Required<WeightVector>;
  facets: Facets;
  /** Which of the four Program charts, if any, is driving the filter. */
  filterSource?: string | undefined;
  /** A camera on the map. Moves the viewport; removes nothing from the table. */
  mapRegion?: string | undefined;
};

const FACET_KEYS = ['country', 'matchStatus', 'riskFlag', 'scoreBand', 'ownershipGroup'] as const;

/**
 * The weight vector is **keyed, not positional**.
 *
 * `w=28.17.17.17.11.10` silently misreads every saved link the moment a
 * Criterion is added or removed — and one was removed during design, when data
 * confidence became a badge. So each weight is its own parameter, `w.<key>`.
 */
const weightParam = (key: string) => `w.${key}`;

/**
 * Reads view state out of a URL.
 *
 * On read: **unknown keys dropped, missing keys filled from the Program
 * default, result renormalised through `score.ts`'s existing renormalisation**
 * — because a missing weight key is structurally identical to a Criterion that
 * drops out as `unknown`, and reusing that path means there is one
 * renormalisation in the codebase rather than two that can disagree.
 */
export function parseViewState(
  params: URLSearchParams | Record<string, string | string[] | undefined>,
  programDefault: WeightVector = DEFAULT_WEIGHTS,
): ViewState {
  const get = (key: string): string | undefined => {
    if (params instanceof URLSearchParams) return params.get(key) ?? undefined;
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const supplied: WeightVector = {};
  for (const key of WEIGHTED_CRITERIA) {
    const raw = get(weightParam(key));
    if (raw == null) continue;
    const value = Number(raw);
    // An unparseable or negative weight is dropped rather than honoured, and
    // the Program default fills the gap.
    if (Number.isFinite(value) && value >= 0) supplied[key] = value;
  }

  const facets: Facets = {};
  for (const key of FACET_KEYS) {
    const raw = get(key);
    if (raw) facets[key] = raw.split(',').filter(Boolean);
  }

  return {
    weights: normaliseWeights(supplied, programDefault),
    facets,
    filterSource: get('from'),
    mapRegion: get('region'),
  };
}

/**
 * Writes view state into a query string.
 *
 * Only what **differs from the Program default** is written, so a shared link
 * says what it means: a URL with no `w.` parameters is the Program's own
 * ranking, and one with them is explicitly a what-if.
 */
export function toSearchParams(state: ViewState, programDefault: WeightVector = DEFAULT_WEIGHTS): URLSearchParams {
  const params = new URLSearchParams();
  const base = normaliseWeights(programDefault);

  for (const key of WEIGHTED_CRITERIA) {
    if (state.weights[key] !== base[key]) params.set(weightParam(key), String(state.weights[key]));
  }
  for (const key of FACET_KEYS) {
    const values = state.facets[key];
    if (values?.length) params.set(key, values.join(','));
  }
  if (state.filterSource) params.set('from', state.filterSource);
  if (state.mapRegion) params.set('region', state.mapRegion);

  return params;
}

/** True when the rail is off the Program default — the transient what-if chip. */
export function isWhatIf(state: ViewState, programDefault: WeightVector = DEFAULT_WEIGHTS): boolean {
  const base = normaliseWeights(programDefault);
  return WEIGHTED_CRITERIA.some((key) => state.weights[key] !== base[key]);
}

export function hasFilter(state: ViewState): boolean {
  return FACET_KEYS.some((key) => (state.facets[key]?.length ?? 0) > 0);
}

/**
 * **A discrete act pushes history; a continuous gesture replaces it**
 * (SPEC §13.5).
 *
 * One slider drag must not bury the spine under twenty entries, so a drag
 * replaces. A preset click, a chat-driven change and a spine navigation are
 * each one decision, so they push.
 */
export type HistoryMode = 'push' | 'replace';

export function historyModeFor(gesture: 'drag' | 'preset' | 'chat' | 'navigate' | 'filter'): HistoryMode {
  return gesture === 'drag' ? 'replace' : 'push';
}

/**
 * The one act separating a what-if from the record is **"Save as Program
 * default"**, and it is UI-only. Everything else here stays in the address bar.
 */
export const RESET_TO_DEFAULT_LABEL = 'Reset to Programme default';

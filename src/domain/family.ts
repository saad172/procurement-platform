import { parseRiskObject, type RiskFactor, type RiskLevel } from './scoring/risk-factors';

/**
 * The Corporate family (SPEC §8).
 *
 * Graduated from a measurement, and it changed the heaviest Criterion in the
 * app. Three facts carry the whole design:
 *
 * 1. **The family costs one call, not 25.** `traversal.ownership` returns each
 *    path terminal as a **full entity with its `risk` block inline**, so the
 *    family read never has to fan out into fifty `getEntity` calls. That price
 *    is what put it on the *standard* enrichment path rather than behind a
 *    button — and a badge that only appears when someone thinks to ask is a
 *    badge the Shortlist cannot be trusted to carry.
 *
 * 2. **The family is downward-only and psa-routed.** The paths run through one
 *    or two `possibly_same_as` hops to *other records of the same company*:
 *    Sayari splits a company across records and the ownership hangs off the
 *    others. On the measured company `traversal.ubo` returned 0 and
 *    ownership-typed `traversal.traversal` at depth 2 returned 0, while
 *    `traversal.ownership` reached all 17 members.
 *
 * 3. **A family member's risk badges and never deducts.** The seed contains two
 *    shared-parent pairs, so a deduction would move two Suppliers' ranks off one
 *    shared fact — the double-count already refused for shared ownership.
 *    **Ranks do not move.**
 */

export type FamilyMemberRisk = {
  entityId: string;
  label: string;
  country: string | null;
  factors: RiskFactor[];
  /**
   * Ownership hops from the root, `possibly_same_as` steps not counted.
   *
   * A Deep Traversal reaches members at depth 2 and 3 that the automatic read
   * stopped short of, and CONTEXT says such a member is *a Family member like
   * any other* — so the depth is carried on the same type rather than on a
   * parallel one, and the panel renders it in the same table.
   */
  hopDepth: number;
  /** True when a Deep Traversal found it rather than the automatic read. */
  fromDeepTraversal: boolean;
};

/**
 * How much of a family one read covered.
 *
 * `explored` is how many members are held; `reachable` is how many the API says
 * exist. `partial` is the third fact and it is not derivable from the other
 * two: a walk that stopped at its own cap holds a known count of an **unknown**
 * total, which reads identically to a complete small family unless it is said.
 */
export type FamilyCoverage = {
  explored: number;
  reachable: number | null;
  /** True when the walk stopped at a cap rather than at the end of the graph. */
  partial?: boolean | undefined;
};

/**
 * **Family exposure no longer badges separately** (network spec §5, ticket
 * 03 unit 03b, CONTEXT.md's *Family exposure*). This file used to compute a
 * three-state badge here (`computeFamilyExposure`/`describeFamilyExposure`,
 * `not_covered` / `no_exposure_found` / `exposure_found`) from exactly the
 * `FamilyMemberRisk[]`/`FamilyCoverage` shapes still defined above — that
 * badge, and its Corporate-family-only scope, is gone. A Corporate family
 * member's own risk is now folded into `networkExposure`
 * (`src/domain/scoring/criteria.ts`) alongside the watchlist walk and the
 * Supplier's own one-hop owners, deducted once per entity at its worst level
 * with a hop discount — never twice, and never in a separate ink from the
 * rest of the Network. `FamilyMemberRisk`/`FamilyCoverage` themselves stay:
 * `family-members.ts`'s `writeGraphPaths` still returns the former, and
 * `derive-supplier-page.ts`'s `deriveFamilyCoverage` (the Supplier page's own
 * concern, not this ticket's) still uses the latter for the coverage
 * sentence beside the diagram.
 *
 * `rank`, below, is `unionRiskFactors`' own comparator now — it moved with
 * that function's doc comment rather than the removed badge's, since that is
 * its one remaining caller.
 */
const rank = (level: RiskLevel) => (level === 'high' ? 3 : level === 'elevated' ? 2 : 1);

/**
 * **When two Sayari endpoints disagree about an entity's risk, union them with
 * per-factor provenance** (SPEC §8.2).
 *
 * Measured: one company carried **10** factors in the traversal payload and
 * **6** from `getEntity`, and the four missing from the second included an
 * elevated forced-labour factor. Taking either endpoint as authoritative would
 * have dropped it.
 */
export function unionRiskFactors(
  sources: readonly { source: string; risk: unknown }[],
): { factor: RiskFactor; sources: string[] }[] {
  const merged = new Map<string, { factor: RiskFactor; sources: string[] }>();

  for (const { source, risk } of sources) {
    for (const factor of parseRiskObject(risk)) {
      const existing = merged.get(factor.name);
      if (!existing) {
        merged.set(factor.name, { factor, sources: [source] });
        continue;
      }
      existing.sources.push(source);
      // Where both report a level, keep the worse one: a factor reported as
      // `high` by one endpoint and `elevated` by another is at least elevated,
      // and understating it is the more dangerous error.
      if (
        factor.level &&
        (!existing.factor.level || rank(factor.level) > rank(existing.factor.level))
      ) {
        existing.factor = { ...existing.factor, level: factor.level };
      }
      // Keep whichever traversal path we have; it is the evidence a sentence cites.
      if (!existing.factor.traversalPath && factor.traversalPath) {
        existing.factor = { ...existing.factor, traversalPath: factor.traversalPath };
      }
    }
  }

  return [...merged.values()];
}

/**
 * The endpoint that produced an entity payload, for the risk provenance
 * `upsertEntity` writes on every merge (SPEC §8.2 D5).
 *
 * Open-ended by design — a template-literal-style union rather than a closed
 * enum — because the SDK has more entity-shaped endpoints than this ticket
 * touches (`entitySummary` for the pre-pass Candidates, `resolution`,
 * `searchEntity`, …) and a factor's `sources` array is a citation list, not a
 * schema: a name this build has not named yet still merges and still gets
 * remembered, rather than being coerced into a lie or refused.
 */
export type EntitySource =
  | 'getEntity'
  | 'ownership'
  | 'ubo'
  | 'traversal'
  | 'entitySummary'
  | 'resolution'
  | 'searchEntity'
  | 'tradeSearch'
  | (string & {});

/**
 * The rank a factor's RAW `level` string sorts at for this merge — wider than
 * `RiskLevel`/`rank()` above, which only know `high`/`elevated`/`relevant`
 * (PR #19 review item P1).
 *
 * Sayari reports `level: "critical"` on `risk.sanctioned` and its siblings —
 * measured 185 times across recorded bodies — which `RiskLevel` does not
 * name and `parseRiskObject` therefore reads as no level at all. Ranking it
 * above `high` here is scoped to THIS merge only: `parseRiskObject` and
 * scoring are unchanged by this ticket, so a `critical` factor still scores
 * as unleveled downstream — a separate, pre-existing gap, not one this fix
 * closes (see the PR's report).
 */
const EXTENDED_LEVEL_RANK: Record<string, number> = {
  critical: 4,
  high: 3,
  elevated: 2,
  relevant: 1,
};

function extendedRank(level: unknown): number {
  return typeof level === 'string' ? (EXTENDED_LEVEL_RANK[level] ?? 0) : 0;
}

/**
 * Shallow-merges two `metadata` objects so a field present on either side
 * survives — a `traversal_path` a traversal sighting reported must not be
 * dropped by a later `getEntity` sighting whose own metadata carries none,
 * and `metadata.source`/`metadata.from_date` on a sanctions factor must
 * survive a smaller sighting the same way. `winner`'s own value for a key
 * both sides carry wins; `loser` only fills gaps.
 */
function mergeMetadata(winner: unknown, loser: unknown): Record<string, unknown> {
  const left = winner && typeof winner === 'object' ? (winner as Record<string, unknown>) : {};
  const right = loser && typeof loser === 'object' ? (loser as Record<string, unknown>) : {};
  const merged: Record<string, unknown> = { ...left };
  for (const [key, value] of Object.entries(right)) {
    if (merged[key] === undefined) merged[key] = value;
  }
  return merged;
}

type RawFactor = Record<string, unknown>;

/** Every named-object factor of a raw `risk` blob, keyed by factor name. */
function asRawRiskMap(risk: unknown): Record<string, RawFactor> {
  if (!risk || typeof risk !== 'object') return {};
  const out: Record<string, RawFactor> = {};
  for (const [name, raw] of Object.entries(risk as Record<string, unknown>)) {
    if (raw && typeof raw === 'object') out[name] = raw as RawFactor;
  }
  return out;
}

/**
 * The stored shape for one factor — **always exactly `level`/`value`/
 * `metadata`**, unchanged from before this ticket, because `risk` reaches a
 * model turn verbatim (see this function's own doc comment) and a stored
 * shape that varies by how many sightings a factor has had would move a
 * prompt's bytes for no reason a person asked for. What P1 fixes is what
 * goes INTO those three fields, not the shape itself: `level` is copied
 * through RAW rather than filtered to the three values `RiskLevel` names —
 * `parseRiskObject`'s job, not this one — and `metadata` copies every key
 * Sayari attached rather than only `country`/`traversal_path`.
 */
function normalizeStoredFactor(level: unknown, value: unknown, metadata: unknown): RawFactor {
  return {
    level: level ?? null,
    value: value ?? null,
    metadata: metadata && typeof metadata === 'object' ? { ...(metadata as Record<string, unknown>) } : {},
  };
}

/**
 * Merges one factor's two raw sightings into the stored shape above.
 *
 * Only one side present: that side's own `level`/`value`/`metadata`,
 * normalized. Both present: the side with the (extended-ranked) WORSE level
 * wins its `level`/`value`, and `metadata` is the union of both sides' keys
 * — a `traversal_path` one sighting reported must survive a later sighting
 * whose own metadata lacks one, and `metadata.source`/`metadata.from_date`
 * on a sanctions factor must survive a smaller sighting the same way. Ties
 * favour the existing side: nothing new was learned, so nothing new is
 * written.
 */
function mergeRawFactor(existing: RawFactor | undefined, incoming: RawFactor | undefined): RawFactor {
  if (!existing) return normalizeStoredFactor(incoming!.level, incoming!.value, incoming!.metadata);
  if (!incoming) return normalizeStoredFactor(existing.level, existing.value, existing.metadata);
  const winner = extendedRank(incoming.level) > extendedRank(existing.level) ? incoming : existing;
  const loser = winner === incoming ? existing : incoming;
  return normalizeStoredFactor(winner.level, winner.value, mergeMetadata(winner.metadata, loser.metadata));
}

/**
 * Merges a newly-sighted `risk` object into what a previous `upsertEntity`
 * call already wrote, for one factor at a time (SPEC §8.2 D5).
 *
 * This is **not** `unionRiskFactors` reused, and the difference is why a
 * separate function exists: `unionRiskFactors` gives every factor parsed out
 * of one `risk` blob the *same* source label, which is exactly right for
 * combining two freshly-fetched payloads in memory, but wrong here — the
 * *existing* side of this merge is a row that may already carry a different
 * source list **per factor**, the residue of every merge before this one.
 * Labelling the whole existing blob "existing" would discard that history on
 * every write.
 *
 * **Merged on the RAW `level`/`value`/`metadata`, never through
 * `parseRiskObject`** (P1). `parseRiskObject` exists to hand `entity.risk` to
 * a model turn verbatim and is deliberately narrow for THAT job — `level`
 * restricted to the three values the Criteria score on, `metadata` narrowed
 * to `country`/`traversal_path` — which is exactly wrong for a MERGE: reusing
 * it here silently voided `level: "critical"` to `null` and dropped every
 * other `metadata` key (`source`, `from_date`, …) on the very next upsert,
 * whichever endpoint reported it. `normalizeStoredFactor`/`mergeRawFactor`
 * below read and write the raw `level`/`metadata` directly instead — the
 * stored shape is unchanged (still exactly `level`/`value`/`metadata` per
 * factor, so a prompt already recorded against it does not move), only what
 * survives into it does.
 *
 * **Two return values, for two columns.** `risk` keeps Sayari's own shape —
 * because `src/tools/catalog/reads.ts` hands it to a model turn verbatim;
 * `sources` is the flat `{ [factorName]: string[] }` map `upsertEntity`
 * writes to the sibling `risk_sources` column. See the schema comment on
 * `entity.risk` for why the two are not one jsonb blob: an inline `sources`
 * key broke two assess/recommend replays the first time this was tried,
 * because the exact shape of `entity.risk` reaches a live prompt unfiltered.
 *
 * Returns `undefined` when this sighting says nothing about risk at all, so
 * `upsertEntity`'s "a column moves only when the incoming sighting states it"
 * rule holds for `risk` exactly as it does for every other column — a caller
 * that gets `undefined` back knows to leave both columns alone.
 */
export function mergeRiskForUpsert(
  existingRisk: unknown,
  existingSources: unknown,
  incomingRisk: unknown,
  source: EntitySource,
): { risk: Record<string, unknown>; sources: Record<string, string[]> } | undefined {
  if (incomingRisk === undefined) return undefined;

  const priorSourcesByName = parseSourceMap(existingSources);
  const existingMap = asRawRiskMap(existingRisk);
  const incomingMap = asRawRiskMap(incomingRisk);
  const names = new Set([...Object.keys(existingMap), ...Object.keys(incomingMap)]);

  const risk: Record<string, unknown> = {};
  const sources: Record<string, string[]> = {};
  for (const name of names) {
    const incomingFactor = incomingMap[name];
    risk[name] = mergeRawFactor(existingMap[name], incomingFactor);

    const priorSources = priorSourcesByName[name] ?? [];
    sources[name] = incomingFactor
      ? priorSources.includes(source)
        ? priorSources
        : [...priorSources, source]
      : priorSources;
  }
  return { risk, sources };
}

/** Reads the `risk_sources` column back into a plain `{ name: sources[] }` map. */
function parseSourceMap(riskSources: unknown): Record<string, string[]> {
  if (!riskSources || typeof riskSources !== 'object') return {};
  const out: Record<string, string[]> = {};
  for (const [name, raw] of Object.entries(riskSources as Record<string, unknown>)) {
    if (Array.isArray(raw)) out[name] = raw.filter((s): s is string => typeof s === 'string');
  }
  return out;
}

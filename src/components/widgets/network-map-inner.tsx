'use client';

/**
 * `network-map-inner.tsx` — the real cytoscape-rendering component (ticket 05,
 * network spec §8). **Nothing outside this widgets directory should import
 * this file directly.** `cytoscape` touches `window`/`document` at
 * module-evaluation time, and a Server Component renders with neither —
 * importing this file from one throws.
 *
 * Import `./network-map.tsx` instead, which is the whole reason this is two
 * files rather than the one `network-map.tsx` the ticket's own file list
 * names:
 *
 *   `node_modules/next/dist/docs/01-app/02-guides/lazy-loading.md`:
 *   > `ssr: false` option is not supported in Server Components. You will see
 *   > an error if you try to use it in Server Components. `ssr: false` is not
 *   > allowed with `next/dynamic` in Server Components. Please move it into a
 *   > Client Component.
 *
 * A page under `src/app` is a Server Component by default
 * (`05-server-and-client-components.md`: "By default, layouts and pages are
 * Server Components"), and the whole point of loading cytoscape with
 * `dynamic(..., { ssr: false })` is to keep it out of the server render and
 * out of the FIRST client bundle. That `dynamic()` call itself therefore has
 * to live in a file already marked `'use client'` — so `network-map.tsx` is a
 * thin `'use client'` wrapper around
 * `dynamic(() => import('./network-map-inner'), { ssr: false, loading: ... })`,
 * and THIS file, being the dynamic import's *target* rather than the
 * component a Server Component page names directly, never needs the
 * `ssr:false` option itself — it only needs `'use client'`, because it calls
 * `useState`/`useEffect`/`useRouter` and touches the DOM through cytoscape.
 *
 * Every page that wants the diagram (Supplier, Category, Recommendation,
 * Entity — units 05e/05f/05g) imports `NetworkMap` from `./network-map`,
 * never anything from this file.
 *
 * ## The >200-node decision (network spec §12)
 *
 * Queried against the dev database (50-supplier roster, migrated through
 * 0019) before deciding, rather than guessing:
 *
 *     SELECT root_entity_id, kind, COUNT(*) FROM graph_path
 *     GROUP BY root_entity_id, kind ORDER BY COUNT(*) DESC LIMIT 10;
 *
 * — capped at 50 rows per (root, kind) exactly as the reads are configured
 * (`limit: 50` on `traversal.watchlist`/`traversal.ownership`, network spec
 * §4.1), so no single kind ever tops 100. The real number is the UNION of
 * every entity referenced by every edge across every kind (family unfiltered,
 * family filtered, watchlist) a root holds — the actual node count a diagram
 * of that Network would draw:
 *
 *     BORGWARNER INC       197 nodes, 198 edges
 *     Forvia SE            194 nodes, 193 edges
 *     延锋汽车饰件系统有限公司  186 nodes, 185 edges
 *     CUMMINS INC.          182 nodes, 182 edges
 *     AISIN CORPORATION     182 nodes, 183 edges
 *     DuPont de Nemours     180 nodes, 179 edges
 *     TOYODA GOSEI          179 nodes, 178 edges
 *     DENSO CORPORATION     177 nodes, 176 edges
 *
 * — measured from `entity_relationship` rows joined off every `edge_ids`
 * array a root's `graph_path` rows cite, on the AUTOMATIC reads alone, before
 * this ticket's own trade Job or any Deep Traversal adds a single row. Ten
 * suppliers already sit at 85–99% of 200 on data that exists today; the trade
 * Job (`supply_chain` Paths) and Entity-page Deep Traversal only add more.
 * §12's "past 200 nodes" is not a hypothetical edge case for this roster — it
 * is where the largest several real Suppliers already are.
 *
 * That measurement rules out two of the four scoped options outright:
 *
 * - **Fallback to chain-rows past the threshold** (diagram declines to
 *   render) would silently revert "the diagram is primary" (spec §8) for
 *   BorgWarner, Forvia, Cummins, Aisin, DuPont, Toyoda Gosei and Denso —
 *   real, large automotive suppliers whose ownership complexity is exactly
 *   why a diagram earns its keep, not an unlucky tail case.
 * - **An uncapped force-directed layout with no cap** degrades into the
 *   "hairball" cytoscape's own docs warn about well before 200 nodes, and
 *   re-running `cose` physics at that scale on every layout pass has a real
 *   cost — see "no re-layout on pan/zoom" below for how this build avoids
 *   paying it more than once per view.
 *
 * What is built here is a **hybrid of the other two**: a hard node cap
 * (`DEFAULT_NODE_CAP`, 200 — spec §12's own framing number) below which every
 * node and every real edge draws individually with `cose`, exactly as today;
 * past the cap, the closest-to-root `cap` nodes still draw individually and
 * the remainder is **clustered by `(kind, hop depth)`** — one node per e.g.
 * "12 more hop-4 watchlist counterparties" (the ticket's own scoping example
 * for this option), tap to expand in place — plus a coverage sentence in the
 * same "N of M" register `NetworkPathCoverage`/`describeNetworkCoverage`
 * already established on the Supplier page (`sections.tsx`), so a capped
 * diagram states what it left out rather than pretending completeness.
 *
 * This buys most of full clustering's reader value (nothing at the visible
 * top of the Network — the entities closest to the root, the ones a
 * Concentration or a Network exposure deduction is actually about — is ever
 * hidden without saying so) at a fraction of its build cost: `visibleElements`
 * below is a projection over already-loaded data, so expanding a cluster
 * costs one React re-render and zero upstream calls, never a second `paths`
 * fetch. `selectLayoutPlan` and `buildNetworkElements` are the two pieces of
 * this decision that are actually load-bearing logic rather than judgement
 * calls, and both are unit-tested directly (`tests/components/widgets/network-map.test.ts`).
 *
 * **No re-layout on pan/zoom.** `cose` runs exactly once per mount and once
 * per element-set change (data arriving, or a cluster expand/collapse
 * toggling `expandedClusters`) — the `useEffect` below is keyed on the
 * *elements*, and cytoscape's own pan/zoom are pure viewport transforms that
 * never touch React state, so they never re-trigger it. That is the answer
 * to the "re-running physics on every pan/zoom" cost the brief and
 * cytoscape's own docs both warn about, not a switch to a different layout
 * algorithm for the capped case — both strategies use `cose`; the decision
 * is about how many elements ever reach it, never about which algorithm
 * lays them out.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import cytoscape from 'cytoscape';
import { isOwnership, isPossiblySameAs } from '@/domain/relationships';
import {
  effectiveLevel,
  isCountryDerived,
  parseRiskObject,
  type RiskFactor,
  type RiskLevel,
} from '@/domain/scoring/risk-factors';

// ── The public prop shape ───────────────────────────────────────────────────
//
// Deliberately its OWN small structural type, not an import of `FamilyPath`/
// `NetworkPath`/`NetworkExposurePath` from `src/db/queries/family-paths.ts` —
// this codebase's own repeated pattern for two shapes that must never be
// forced to drift together (`NetworkExposurePath`'s and `loadNetworkPaths`'s
// own doc comments there both make this same call). Every field name and
// type below matches those query functions' return shapes exactly, so a
// Server Component page passes the query's result straight through with NO
// per-caller transform:
//
//   - `loadFamilyPaths()` returns `FamilyPath[]`, which carries no `kind`
//     field at all — every Path it returns is a `family` Path by
//     construction, which is exactly why `NetworkMapPath.kind` is OPTIONAL
//     here (defaults to `'family'`). `FamilyPath[]` is assignable to
//     `NetworkMapPath[]` with zero mapping.
//   - `loadNetworkPaths()`/`loadNetworkExposurePaths()` return arrays whose
//     rows carry `kind`, plus extra fields this component does not read
//     (`enrichmentId`, `discoveredByJob`, `truncated`, `reachableCount`,
//     `hopDepth`) — TypeScript's excess-property check only fires on object
//     LITERALS assigned to a narrower type, never on an existing array
//     passed as a prop, so those extra fields cost a caller nothing either.
export type NetworkMapPathKind =
  | 'family'
  | 'watchlist'
  | 'shortest_path'
  | 'deep_traversal'
  | 'supply_chain';

/** One cited edge — matches `FamilyPathEdge` (`src/db/queries/family-paths.ts`) field for field. */
export type NetworkMapEdge = {
  id: string;
  relationshipType: string;
  fromEntityId: string;
  toEntityId: string;
  former: boolean;
  sharePercentage: number | null;
  startDate: string | null;
  endDate: string | null;
  sourceRecordId: string | null;
};

/** One Path, hydrated with its chain — matches `FamilyPath`'s shape for the fields this diagram reads. */
export type NetworkMapPath = {
  /** `graph_path.kind`. Optional: absent (as from `loadFamilyPaths`) reads as `'family'`. */
  kind?: NetworkMapPathKind;
  terminalEntityId: string;
  label: string;
  country?: string | null;
  sanctioned?: boolean;
  /** `entity.risk`, verbatim — parsed with `parseRiskObject`/`effectiveLevel`, the same pair Compliance risk itself reads through, for this node's hover level and factors. */
  risk?: unknown;
  edges: NetworkMapEdge[];
  /**
   * Which root this Path was found from. Optional and single-root by default
   * (every existing `loadFamilyPaths(db, rootEntityId)`/`loadNetworkPaths(db,
   * rootEntityId)` call already fixes one root per call) — a page overlaying
   * several roots' Networks in one diagram (Category's Concentration map,
   * spec §8, if a future unit chooses to compose that way rather than one
   * `<NetworkMap>` per Supplier) sets this per Path; every other caller
   * omits it and every Path defaults to `roots[0]`.
   */
  rootEntityId?: string;
};

/** The entity this diagram's hub represents — a page's own already-loaded Profile/Supplier/entity row, not a new query. */
export type NetworkMapRoot = { id: string; label: string };

export type NetworkMapProps = {
  /** One entry for the ordinary case (Supplier, Recommendation, Entity pages); more than one only for a page overlaying several Networks in one diagram. */
  roots: NetworkMapRoot[];
  paths: NetworkMapPath[];
  programId: string;
  /** Overrides `DEFAULT_NODE_CAP` — exposed for tests and future tuning, not expected to vary per page. */
  nodeCap?: number;
  /**
   * The Expand seam (spec §8): wiring it to a real confirm-gated Deep
   * Traversal enqueue is NOT this component's job (unit 05g's, for the
   * Recommendation/Entity pages) — this only calls it with the tapped
   * entity's id. A Server Component page cannot pass a function prop
   * directly (React Server Component payloads cannot serialise functions);
   * the caller supplying `onExpand` must itself be (or be wrapped by) a
   * `'use client'` component, the same rule that already applies to any
   * `onClick` handed to a Client Component from a Server Component.
   */
  onExpand?: (entityId: string) => void;
  className?: string;
};

// ── Href conventions ────────────────────────────────────────────────────────
//
// Match the Supplier page's own two conventions exactly
// (`src/app/program/[programId]/supplier/[supplierId]/sections.tsx`) so a
// tap on this diagram lands on the identical URL a click in `FamilyChainRows`
// or `NetworkMembersTable` would produce — never a second, drifting
// convention invented here.

/** Matches every `Link href={\`/program/${programId}/entity/${id}\`}` in `sections.tsx`. */
export function buildEntityHref(programId: string, entityId: string): string {
  return `/program/${programId}/entity/${entityId}`;
}

/** Matches `sections.tsx`'s own `recordHref` — a record id is itself a `/`-joined path, so the catch-all segment is built the same way, encoded per-part. */
export function buildRecordHref(programId: string, recordId: string): string {
  return `/program/${programId}/record/${recordId.split('/').map(encodeURIComponent).join('/')}`;
}

// ── The >200-node decision, as code ─────────────────────────────────────────

/** Spec §12's own framing number — see this file's header comment for why. */
export const DEFAULT_NODE_CAP = 200;

export type LayoutStrategy = 'full' | 'capped';
export type LayoutPlan = { strategy: LayoutStrategy; cap: number; totalNodeCount: number };

/** Given how many nodes a Network's Paths would draw, which of the two element-count strategies applies. Both use `cose`; see this file's header comment. */
export function selectLayoutPlan(
  totalNodeCount: number,
  cap: number = DEFAULT_NODE_CAP,
): LayoutPlan {
  return { strategy: totalNodeCount > cap ? 'capped' : 'full', cap, totalNodeCount };
}

const KIND_PRIORITY: Record<NetworkMapPathKind, number> = {
  family: 0,
  watchlist: 1,
  shortest_path: 2,
  deep_traversal: 3,
  supply_chain: 4,
};

/** Wording deliberately matches `SupplierFamilyWidget`'s `KIND_LABEL` (`src/components/widgets/supplier-family.tsx`) for one shared vocabulary — that map is module-private there, so this is a second, small, allowed-to-drift copy rather than an export added to a file this unit does not own. */
const KIND_LABEL: Record<NetworkMapPathKind, string> = {
  family: 'corporate-family entities',
  watchlist: 'watchlist counterparties',
  shortest_path: 'shortest-path entities',
  deep_traversal: 'deep-traversal entities',
  supply_chain: 'supply-chain entities',
};

function shortenId(id: string): string {
  return id.length <= 10 ? id : `${id.slice(0, 8)}…`;
}

/** The worst `effectiveLevel` among an entity's own (non-country-derived) risk factors, and their names — the same reduction `worstLevel` performs in `src/domain/scoring/criteria.ts`, re-derived here because that one is not exported (a private helper of a Criterion this component does not score). */
function worstLevelAndFactors(risk: unknown): { level: RiskLevel | undefined; factors: string[] } {
  const rank = (level: RiskLevel) => (level === 'high' ? 3 : level === 'elevated' ? 2 : 1);
  const withLevel = parseRiskObject(risk)
    .filter((f): f is RiskFactor => !isCountryDerived(f))
    .map((f) => ({ name: f.name, level: effectiveLevel(f) }))
    .filter((f): f is { name: string; level: RiskLevel } => f.level != null);
  const level = withLevel.reduce<RiskLevel | undefined>(
    (best, f) => (best == null || rank(f.level) > rank(best) ? f.level : best),
    undefined,
  );
  return { level, factors: withLevel.map((f) => f.name) };
}

type NodeMeta = {
  kind: NetworkMapPathKind | 'root';
  label: string;
  hasKnownLabel: boolean;
  level: RiskLevel | undefined;
  factors: string[];
  sanctioned: boolean;
  country: string | null;
};

type EdgeInput = NetworkMapEdge & { kind: NetworkMapPathKind; synthetic: boolean };

/** Every cited edge across every Path, deduped by `entity_relationship.id` (a shared intermediate hop is cited once); a synthetic "no citable edge yet" edge stands in for a Path whose `edges` have not been hydrated yet (`FamilyChainRows`'s own documented gap, same wording). First Path to name an edge or a zero-edge terminal wins its `kind` tag. */
function collectEdges(
  paths: readonly NetworkMapPath[],
  primaryRootId: string,
): Map<string, EdgeInput> {
  const edges = new Map<string, EdgeInput>();
  for (const path of paths) {
    const kind = path.kind ?? 'family';
    const rootId = path.rootEntityId ?? primaryRootId;
    if (path.edges.length === 0) {
      const id = `no-edge:${rootId}:${path.terminalEntityId}`;
      if (!edges.has(id)) {
        edges.set(id, {
          id,
          relationshipType: 'no citable edge yet',
          fromEntityId: rootId,
          toEntityId: path.terminalEntityId,
          former: false,
          sharePercentage: null,
          startDate: null,
          endDate: null,
          sourceRecordId: null,
          kind,
          synthetic: true,
        });
      }
      continue;
    }
    for (const edge of path.edges) {
      if (!edges.has(edge.id)) edges.set(edge.id, { ...edge, kind, synthetic: false });
    }
  }
  return edges;
}

/** Every node's identity: a root's own label always wins; a Path's terminal supplies label/risk/country/sanctioned; an entity known only as an edge endpoint (an unhydrated intermediate hop — no query in this build loads its label, a real and documented gap) falls back to a shortened id. First Path in caller order wins a contested terminal's identity. */
function collectNodeMeta(
  roots: readonly NetworkMapRoot[],
  paths: readonly NetworkMapPath[],
  edges: ReadonlyMap<string, EdgeInput>,
): Map<string, NodeMeta> {
  const meta = new Map<string, NodeMeta>();
  const unlabeled = (kind: NetworkMapPathKind): NodeMeta => ({
    kind,
    label: '',
    hasKnownLabel: false,
    level: undefined,
    factors: [],
    sanctioned: false,
    country: null,
  });
  for (const path of paths) {
    if (meta.has(path.terminalEntityId)) continue;
    const { level, factors } = worstLevelAndFactors(path.risk);
    meta.set(path.terminalEntityId, {
      kind: path.kind ?? 'family',
      label: path.label,
      hasKnownLabel: true,
      level,
      factors,
      sanctioned: path.sanctioned ?? false,
      country: path.country ?? null,
    });
  }
  for (const edge of edges.values()) {
    if (!meta.has(edge.fromEntityId)) meta.set(edge.fromEntityId, unlabeled(edge.kind));
    if (!meta.has(edge.toEntityId)) meta.set(edge.toEntityId, unlabeled(edge.kind));
  }
  for (const root of roots) {
    meta.set(root.id, {
      kind: 'root',
      label: root.label,
      hasKnownLabel: true,
      level: undefined,
      factors: [],
      sanctioned: false,
      country: null,
    });
  }
  return meta;
}

/** Graph distance from the nearest root, over the UNDIRECTED edge set — not `Path.hopDepth` (the "ownership hops, psa excluded" figure `graph_path` stores), because a node's position ON THIS DIAGRAM is what the cap/cluster decision below has to sort by, and a chain's own `fromEntityId`/`toEntityId` framing (subject/target, `src/domain/relationships.ts`) does not reliably say which end sits closer to the root. */
function bfsDepths(
  rootIds: ReadonlySet<string>,
  edges: ReadonlyMap<string, EdgeInput>,
): Map<string, number> {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges.values()) {
    (
      adjacency.get(edge.fromEntityId) ??
      adjacency.set(edge.fromEntityId, []).get(edge.fromEntityId)!
    ).push(edge.toEntityId);
    (
      adjacency.get(edge.toEntityId) ?? adjacency.set(edge.toEntityId, []).get(edge.toEntityId)!
    ).push(edge.fromEntityId);
  }
  const depths = new Map<string, number>();
  const queue: string[] = [];
  for (const id of rootIds) {
    depths.set(id, 0);
    queue.push(id);
  }
  let head = 0;
  while (head < queue.length) {
    const current = queue[head++]!;
    const depth = depths.get(current)!;
    for (const neighbor of adjacency.get(current) ?? []) {
      if (!depths.has(neighbor)) {
        depths.set(neighbor, depth + 1);
        queue.push(neighbor);
      }
    }
  }
  return depths;
}

export type NetworkMapNode = {
  id: string;
  label: string;
  hasKnownLabel: boolean;
  kind: NetworkMapPathKind | 'root';
  depth: number;
  level: RiskLevel | undefined;
  factors: string[];
  sanctioned: boolean;
  country: string | null;
  href: string;
};

export type NetworkMapClusterNode = {
  id: string;
  kind: NetworkMapPathKind;
  depth: number;
  count: number;
  memberEntityIds: string[];
  label: string;
};

export type NetworkMapEdgeElement = {
  id: string;
  source: string;
  target: string;
  relationshipType: string;
  label: string;
  former: boolean;
  sharePercentage: number | null;
  startDate: string | null;
  endDate: string | null;
  href: string | null;
  synthetic: boolean;
};

export type NetworkMapAnalysis = {
  plan: LayoutPlan;
  nodes: NetworkMapNode[];
  edges: NetworkMapEdgeElement[];
  clusters: NetworkMapClusterNode[];
  keptNodeIds: string[];
  primaryRootId: string | null;
};

/** Sorts the overflow closest-to-root first (kind as the tie-break, `family` before `watchlist` before the rest — spec §6's own listed order) and buckets what does not fit by `(kind, depth)`. Nothing about *which* nodes draw individually is random or server-order-dependent: same input, same cap, same output. */
function partitionForCap(
  nodeIds: readonly string[],
  depths: ReadonlyMap<string, number>,
  meta: ReadonlyMap<string, NodeMeta>,
  rootIds: ReadonlySet<string>,
  cap: number,
): { kept: Set<string>; clusters: NetworkMapClusterNode[] } {
  const nonRoot = nodeIds.filter((id) => !rootIds.has(id));
  const sorted = [...nonRoot].sort((a, b) => {
    const depthDiff = (depths.get(a) ?? Infinity) - (depths.get(b) ?? Infinity);
    if (depthDiff !== 0) return depthDiff;
    const kindA = (meta.get(a)?.kind ?? 'family') as NetworkMapPathKind;
    const kindB = (meta.get(b)?.kind ?? 'family') as NetworkMapPathKind;
    const priorityDiff = KIND_PRIORITY[kindA] - KIND_PRIORITY[kindB];
    return priorityDiff !== 0 ? priorityDiff : a.localeCompare(b);
  });
  const budget = Math.max(0, cap - rootIds.size);
  const kept = new Set([...rootIds, ...sorted.slice(0, budget)]);
  const buckets = new Map<string, { kind: NetworkMapPathKind; depth: number; ids: string[] }>();
  for (const id of sorted.slice(budget)) {
    const depth = depths.get(id) ?? 0;
    const kind = (meta.get(id)?.kind ?? 'family') as NetworkMapPathKind;
    const key = `${kind}:${depth}`;
    const bucket = buckets.get(key) ?? { kind, depth, ids: [] };
    bucket.ids.push(id);
    buckets.set(key, bucket);
  }
  const clusters = [...buckets.values()].map((b) => ({
    id: `cluster:${b.kind}:${b.depth}`,
    kind: b.kind,
    depth: b.depth,
    count: b.ids.length,
    memberEntityIds: b.ids,
    label: `${b.ids.length} more hop-${b.depth} ${KIND_LABEL[b.kind]}`,
  }));
  return { kept, clusters };
}

/**
 * Paths-as-JSON → the diagram's own node/edge model — cytoscape-agnostic on
 * purpose, so this function (and `visibleElements` below) are testable
 * without touching cytoscape's runtime at all (`tests/components/widgets/network-map.test.ts`).
 */
export function buildNetworkElements(
  roots: readonly NetworkMapRoot[],
  paths: readonly NetworkMapPath[],
  programId: string,
  cap: number = DEFAULT_NODE_CAP,
): NetworkMapAnalysis {
  if (roots.length === 0) {
    return {
      plan: selectLayoutPlan(0, cap),
      nodes: [],
      edges: [],
      clusters: [],
      keptNodeIds: [],
      primaryRootId: null,
    };
  }
  const rootIds = new Set(roots.map((r) => r.id));
  const primaryRootId = roots[0]!.id;
  const edgeMap = collectEdges(paths, primaryRootId);
  const meta = collectNodeMeta(roots, paths, edgeMap);
  const depths = bfsDepths(rootIds, edgeMap);
  const nodeIds = [...meta.keys()];
  const plan = selectLayoutPlan(nodeIds.length, cap);

  const nodes = nodeIds.map((id): NetworkMapNode => {
    const m = meta.get(id)!;
    return {
      id,
      label: m.hasKnownLabel ? m.label : shortenId(id),
      hasKnownLabel: m.hasKnownLabel,
      kind: m.kind,
      depth: depths.get(id) ?? 0,
      level: m.level,
      factors: m.factors,
      sanctioned: m.sanctioned,
      country: m.country,
      href: buildEntityHref(programId, id),
    };
  });
  const edges = [...edgeMap.values()].map(
    (e): NetworkMapEdgeElement => ({
      id: e.id,
      source: e.fromEntityId,
      target: e.toEntityId,
      relationshipType: e.relationshipType,
      label: e.synthetic ? e.relationshipType : e.relationshipType.replace(/_/g, ' '),
      former: e.former,
      sharePercentage: e.sharePercentage,
      startDate: e.startDate,
      endDate: e.endDate,
      href: e.sourceRecordId ? buildRecordHref(programId, e.sourceRecordId) : null,
      synthetic: e.synthetic,
    }),
  );

  if (plan.strategy === 'full') {
    return { plan, nodes, edges, clusters: [], keptNodeIds: nodeIds, primaryRootId };
  }
  const { kept, clusters } = partitionForCap(nodeIds, depths, meta, rootIds, cap);
  return { plan, nodes, edges, clusters, keptNodeIds: [...kept], primaryRootId };
}

/** The currently-drawn subset — `analysis` minus whatever is still clustered, plus a synthetic root→cluster edge for each cluster left collapsed. Expanding a cluster is a pure projection over already-loaded data: no new Path, no upstream call. */
export function visibleElements(
  analysis: NetworkMapAnalysis,
  expandedClusterIds: ReadonlySet<string>,
): { nodes: NetworkMapNode[]; edges: NetworkMapEdgeElement[]; clusters: NetworkMapClusterNode[] } {
  if (analysis.plan.strategy === 'full') {
    return { nodes: analysis.nodes, edges: analysis.edges, clusters: [] };
  }
  const keptSet = new Set(analysis.keptNodeIds);
  const extra = new Set<string>();
  const shownClusters: NetworkMapClusterNode[] = [];
  for (const cluster of analysis.clusters) {
    if (expandedClusterIds.has(cluster.id)) for (const id of cluster.memberEntityIds) extra.add(id);
    else shownClusters.push(cluster);
  }
  const visibleIds = new Set([...keptSet, ...extra]);
  const nodes = analysis.nodes.filter((n) => visibleIds.has(n.id));
  const edges = analysis.edges.filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target));
  const clusterEdges: NetworkMapEdgeElement[] = analysis.primaryRootId
    ? shownClusters.map((c) => ({
        id: `cluster-edge:${c.id}`,
        source: analysis.primaryRootId!,
        target: c.id,
        relationshipType: 'grouped',
        label: c.label,
        former: false,
        sharePercentage: null,
        startDate: null,
        endDate: null,
        href: null,
        synthetic: true,
      }))
    : [];
  return { nodes, edges: [...edges, ...clusterEdges], clusters: shownClusters };
}

// ── cytoscape wiring ─────────────────────────────────────────────────────────

/** Mirrors `globals.css`'s own tokens (`--ink`, `--warn`, `--bad`, …) — hardcoded because cytoscape's canvas cannot read a CSS custom property, not because this component owns a second palette. */
const COLORS = {
  ink: '#16181d',
  ink2: '#4a5058',
  ink3: '#5c636d',
  rule: '#e3e6ea',
  paper: '#ffffff',
  paper2: '#f7f8fa',
  accent: '#1f4fd8',
  warn: '#a15c00',
  bad: '#b3261e',
} as const;

function buildStylesheet(): cytoscape.StylesheetJson {
  const sheet = [
    {
      selector: 'node',
      style: {
        'background-color': COLORS.paper2,
        'border-width': 1,
        'border-color': COLORS.rule,
        label: 'data(label)',
        'font-size': 9,
        color: COLORS.ink2,
        'text-valign': 'bottom',
        'text-margin-y': 4,
        width: 22,
        height: 22,
      },
    },
    {
      selector: 'node.root',
      style: {
        'background-color': COLORS.accent,
        'border-width': 2,
        'border-color': COLORS.ink,
        width: 34,
        height: 34,
        color: COLORS.ink,
        'font-weight': 700,
      },
    },
    {
      selector: 'node.unlabeled',
      style: { 'background-color': COLORS.paper, 'border-style': 'dashed', color: COLORS.ink3 },
    },
    { selector: 'node.risk-relevant', style: { 'border-color': COLORS.warn, 'border-width': 2 } },
    { selector: 'node.risk-elevated', style: { 'border-color': COLORS.warn, 'border-width': 3 } },
    { selector: 'node.risk-high', style: { 'border-color': COLORS.bad, 'border-width': 3 } },
    { selector: 'node.sanctioned', style: { 'background-color': COLORS.bad } },
    {
      selector: 'node.cluster',
      style: {
        shape: 'diamond',
        'background-color': COLORS.paper2,
        'border-color': COLORS.ink3,
        'border-style': 'dotted',
        width: 28,
        height: 28,
        label: 'data(label)',
        'font-size': 8,
        color: COLORS.ink3,
      },
    },
    {
      selector: 'edge',
      style: {
        width: 1.5,
        'line-color': COLORS.rule,
        'target-arrow-color': COLORS.rule,
        'target-arrow-shape': 'triangle',
        'curve-style': 'bezier',
        'arrow-scale': 0.8,
      },
    },
    {
      selector: 'edge.ownership',
      style: { 'line-color': COLORS.ink2, 'target-arrow-color': COLORS.ink2 },
    },
    {
      selector: 'edge.psa',
      style: {
        'line-style': 'dotted',
        'line-color': COLORS.ink3,
        'target-arrow-color': COLORS.ink3,
      },
    },
    { selector: 'edge.former', style: { 'line-style': 'dashed', opacity: 0.6 } },
    {
      selector: 'edge.synthetic',
      style: {
        'line-style': 'dashed',
        'line-color': COLORS.ink3,
        'target-arrow-color': COLORS.ink3,
      },
    },
  ];
  return sheet as unknown as cytoscape.StylesheetJson;
}

function buildLayoutOptions(elementCount: number): cytoscape.LayoutOptions {
  return {
    name: 'cose',
    animate: false,
    fit: true,
    padding: 24,
    nodeRepulsion: 8000,
    idealEdgeLength: 60,
    gravity: 0.35,
    numIter: elementCount > 60 ? 800 : 1500,
  } as cytoscape.LayoutOptions;
}

function edgeClasses(edge: NetworkMapEdgeElement): string {
  const meaning = isPossiblySameAs(edge.relationshipType)
    ? 'psa'
    : isOwnership(edge.relationshipType)
      ? 'ownership'
      : 'lateral';
  return [edge.synthetic ? 'synthetic' : 'real', meaning, edge.former ? 'former' : '']
    .filter(Boolean)
    .join(' ');
}

function toCytoscapeElements(
  nodes: NetworkMapNode[],
  clusters: NetworkMapClusterNode[],
  edges: NetworkMapEdgeElement[],
  primaryRootId: string | null,
): cytoscape.ElementDefinition[] {
  const nodeEls = nodes.map((n) => ({
    data: { id: n.id, label: n.label },
    classes: [
      n.id === primaryRootId ? 'root' : n.kind,
      n.level ? `risk-${n.level}` : '',
      n.sanctioned ? 'sanctioned' : '',
      n.hasKnownLabel ? '' : 'unlabeled',
    ]
      .filter(Boolean)
      .join(' '),
  }));
  const clusterEls = clusters.map((c) => ({
    data: { id: c.id, label: c.label },
    classes: `cluster ${c.kind}`,
  }));
  const edgeEls = edges.map((e) => ({
    data: { id: e.id, source: e.source, target: e.target, label: e.label },
    classes: edgeClasses(e),
  }));
  return [...nodeEls, ...clusterEls, ...edgeEls] as cytoscape.ElementDefinition[];
}

type HoverInfo =
  | { type: 'node'; node: NetworkMapNode }
  | { type: 'cluster'; cluster: NetworkMapClusterNode }
  | { type: 'edge'; edge: NetworkMapEdgeElement };

type HandlerContext = {
  router: ReturnType<typeof useRouter>;
  setHover: (info: HoverInfo) => void;
  toggleCluster: (clusterId: string) => void;
  nodesById: Map<string, NetworkMapNode>;
  edgesById: Map<string, NetworkMapEdgeElement>;
  clustersById: Map<string, NetworkMapClusterNode>;
};

/** Pan and zoom are cytoscape's own built-ins — untouched, never rebuilt here. This only wires the four interactions spec §8 asks for: hover (level/factors), click a node (navigate), click an edge (navigate), and the free "expand a cluster in place" affordance §12's decision adds. */
function attachHandlers(cy: cytoscape.Core, ctx: HandlerContext): void {
  cy.on('mouseover', 'node', (evt) => {
    const target = evt.target as cytoscape.NodeSingular;
    const id = target.id();
    const cluster = ctx.clustersById.get(id);
    if (cluster) {
      ctx.setHover({ type: 'cluster', cluster });
      return;
    }
    const node = ctx.nodesById.get(id);
    if (node) ctx.setHover({ type: 'node', node });
  });
  cy.on('mouseover', 'edge', (evt) => {
    const target = evt.target as cytoscape.EdgeSingular;
    const edge = ctx.edgesById.get(target.id());
    if (edge) ctx.setHover({ type: 'edge', edge });
  });
  cy.on('tap', 'node', (evt) => {
    const target = evt.target as cytoscape.NodeSingular;
    const id = target.id();
    const cluster = ctx.clustersById.get(id);
    if (cluster) {
      ctx.toggleCluster(id);
      return;
    }
    const node = ctx.nodesById.get(id);
    if (node) ctx.router.push(node.href as never);
  });
  cy.on('tap', 'edge', (evt) => {
    const target = evt.target as cytoscape.EdgeSingular;
    const edge = ctx.edgesById.get(target.id());
    if (edge?.href) ctx.router.push(edge.href as never);
  });
}

// ── Presentational pieces ────────────────────────────────────────────────────

function NetworkMapCoverageNote({ analysis }: { analysis: NetworkMapAnalysis }) {
  if (analysis.plan.strategy === 'full') return null;
  const shown = analysis.keptNodeIds.length;
  const clustered = analysis.plan.totalNodeCount - shown;
  return (
    <p className="note" style={{ margin: '0.4rem 0 0' }}>
      Showing {shown} of {analysis.plan.totalNodeCount} nodes; {clustered} more grouped by hop depth
      and kind below — tap a grouped marker to show it, or read every cited edge in the chain rows
      beneath.
    </p>
  );
}

function NetworkMapInspector({
  hover,
  onExpand,
}: {
  hover: HoverInfo | null;
  onExpand?: ((entityId: string) => void) | undefined;
}) {
  if (!hover) {
    return (
      <p className="note" style={{ margin: '0.5rem 0 0' }}>
        Hover a node for its level and factors. Click a node to open its Entity page; click an edge
        to open its record.
      </p>
    );
  }
  if (hover.type === 'cluster') {
    return (
      <p className="note" style={{ margin: '0.5rem 0 0' }}>
        <b>{hover.cluster.label}</b> — tap to show these nodes.
      </p>
    );
  }
  if (hover.type === 'edge') {
    const e = hover.edge;
    return (
      <p className="note" style={{ margin: '0.5rem 0 0' }}>
        <b>{e.label}</b>
        {e.sharePercentage != null ? ` · ${e.sharePercentage}%` : ''}
        {e.startDate ? ` · from ${e.startDate}` : ''}
        {e.endDate ? ` · to ${e.endDate}` : ''}
        {e.former ? ' · former' : ''}
        {e.href ? (
          <>
            {' · '}
            <Link href={e.href as never}>open record →</Link>
          </>
        ) : (
          ' · no record cited yet'
        )}
      </p>
    );
  }
  const { node } = hover;
  return (
    <div
      className="note"
      style={{
        margin: '0.5rem 0 0',
        display: 'flex',
        gap: '0.5rem',
        flexWrap: 'wrap',
        alignItems: 'center',
      }}
    >
      <b style={{ color: 'var(--ink)' }}>{node.label}</b>
      {node.level ? (
        <span className={`badge ${node.level === 'high' ? 'bad' : 'warn'}`}>{node.level}</span>
      ) : null}
      {node.sanctioned ? <span className="badge bad">sanctioned</span> : null}
      <span>hop {node.depth}</span>
      {node.factors.length > 0 ? <span>{node.factors.slice(0, 3).join(', ')}</span> : null}
      {!node.hasKnownLabel ? <span>no cached label for this hop</span> : null}
      <Link href={node.href as never}>open entity page →</Link>
      {onExpand && node.kind !== 'root' ? (
        <button type="button" className="badge" onClick={() => onExpand(node.id)}>
          Expand
        </button>
      ) : null}
    </div>
  );
}

// ── The component ────────────────────────────────────────────────────────────

export default function NetworkMapInner({
  roots,
  paths,
  programId,
  nodeCap = DEFAULT_NODE_CAP,
  onExpand,
  className,
}: NetworkMapProps) {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);
  const [expandedClusters, setExpandedClusters] = useState<ReadonlySet<string>>(new Set());
  const [hover, setHover] = useState<HoverInfo | null>(null);

  const analysis = useMemo(
    () => buildNetworkElements(roots, paths, programId, nodeCap),
    [roots, paths, programId, nodeCap],
  );
  const view = useMemo(
    () => visibleElements(analysis, expandedClusters),
    [analysis, expandedClusters],
  );

  const toggleCluster = useCallback((clusterId: string) => {
    setExpandedClusters((prev) => {
      const next = new Set(prev);
      if (next.has(clusterId)) next.delete(clusterId);
      else next.add(clusterId);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!containerRef.current) return undefined;
    const cy = cytoscape({
      container: containerRef.current,
      elements: toCytoscapeElements(view.nodes, view.clusters, view.edges, analysis.primaryRootId),
      style: buildStylesheet(),
      layout: buildLayoutOptions(view.nodes.length + view.clusters.length),
      minZoom: 0.1,
      maxZoom: 4,
    });
    cyRef.current = cy;
    attachHandlers(cy, {
      router,
      setHover,
      toggleCluster,
      nodesById: new Map(view.nodes.map((n) => [n.id, n] as const)),
      edgesById: new Map(view.edges.map((e) => [e.id, e] as const)),
      clustersById: new Map(view.clusters.map((c) => [c.id, c] as const)),
    });
    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, [view, analysis.primaryRootId, router, toggleCluster]);

  if (roots.length === 0) {
    return <p className="empty">No Network to diagram — no root entity.</p>;
  }

  return (
    <div className={className}>
      <div
        ref={containerRef}
        role="img"
        aria-label={`Network diagram rooted at ${roots.map((r) => r.label).join(', ')}`}
        style={{
          height: 420,
          background: 'var(--paper-2)',
          border: '1px solid var(--rule)',
          borderRadius: 'var(--radius)',
        }}
      />
      <NetworkMapCoverageNote analysis={analysis} />
      <NetworkMapInspector hover={hover} onExpand={onExpand} />
    </div>
  );
}

import type { NetworkMapPath, NetworkMapRoot } from '@/components/widgets/network-map';

/**
 * The Category page's Concentration-map transform (network spec §7, §8;
 * ticket 05, unit 05f). **Not a new data shape** — ticket 04's unit 04d
 * already computes Concentration once per Category load
 * (`computeConcentration`, `src/db/queries/shortlist.ts`) and hangs it off
 * every accepted row as `ConcentrationPartner[]` (`ShortlistEntry.concentrationWith`).
 * This is purely a second rendering of that same data, as `NetworkMap` props
 * instead of the Shortlist table's own badge column.
 *
 * ## Why a synthetic Path, not a real one
 *
 * `findConcentrations` (`src/db/queries/family-paths.ts`) is a **self-join on
 * `graph_path`** that reports two accepted Suppliers' root/terminal ids and
 * the shared terminal's label — it deliberately does not carry either side's
 * `edge_ids`, because doing so would mean resolving and hydrating a whole
 * `entity_relationship` chain for a query whose entire point (per that
 * function's own doc comment) is staying "one query regardless of how many
 * entity ids the caller passes." `ConcentrationPartner`
 * (`src/db/queries/shortlist.ts`), what actually reaches this page, carries
 * even less: `{ supplierId, displayName, terminalEntityId, terminalLabel }` —
 * no `kind` (family vs watchlist — `findConcentrations` joins across both
 * without recording which side matched which), no edges, no risk/sanctioned
 * data on the terminal.
 *
 * Widening either query to carry real edges would mean rearchitecting
 * `findConcentrations`'s self-join (fetching and disambiguating each side's
 * `edge_ids` separately, since `gpA`/`gpB` can each be either kind) AND
 * widening `ConcentrationPartner`/`computeConcentration` (outside this unit's
 * files) to carry it through — scope this unit does not own. `NetworkMap`
 * (`network-map-inner.tsx`'s own `collectEdges`) already has a documented,
 * first-class fallback for exactly this: a Path with `edges: []` draws a
 * single synthetic "no citable edge yet" edge from root to terminal, styled
 * distinctly from a real cited hop. Building one such Path per (Supplier,
 * partner) pair below is that fallback, deliberately, not a placeholder to
 * revisit — the real chain a person would want to cite already exists as
 * text: the terminal's name, in the Shortlist table's own Concentration
 * badge title (`sections.tsx`'s `ConcentrationBadge`).
 *
 * ## Roots and edges
 *
 * `NetworkMapPath.rootEntityId` (added by 05d specifically "if a future unit
 * chooses to compose that way" for this exact page, per its own doc comment)
 * lets one `<NetworkMap>` overlay every accepted Supplier's joins in a single
 * diagram, rather than one diagram per Supplier. Every row with at least one
 * Concentration partner becomes a root; every partner entry on that row
 * becomes one Path from that root to the shared terminal. Because
 * `computeConcentration` already widens each pair into both directions (row
 * A lists B, row B lists A), both endpoints of a join end up as roots with
 * their own Path to the shared terminal — the diagram draws both edges
 * converging on one node, which is the join.
 *
 * A row with no `entityId` (no settled Match, so no Network to join through)
 * or no Concentration is never a root here — an isolated node with no edge
 * would be noise on a diagram whose entire purpose is showing joins, not a
 * census of every bidder.
 */
export type ConcentrationSourceRow = {
  supplierId: string;
  displayName: string;
  entityId: string | null;
  concentrationWith: readonly {
    supplierId: string;
    displayName: string;
    terminalEntityId: string;
    terminalLabel: string;
  }[];
};

export type ConcentrationMapProps = {
  roots: NetworkMapRoot[];
  paths: NetworkMapPath[];
};

/**
 * `shortlist.ranked` (or `.excluded`, though an excluded row never carries a
 * Concentration — see this file's own header) → `NetworkMap` props. Pure and
 * synchronous: no query, no upstream call, the same "for free" promise
 * `computeConcentration` already made for the column this diagram sits
 * beside.
 */
export function buildConcentrationMap(
  rows: readonly ConcentrationSourceRow[],
): ConcentrationMapProps {
  const roots = new Map<string, NetworkMapRoot>();
  const paths: NetworkMapPath[] = [];

  for (const row of rows) {
    if (row.entityId == null || row.concentrationWith.length === 0) continue;
    roots.set(row.entityId, { id: row.entityId, label: row.displayName });
    for (const partner of row.concentrationWith) {
      paths.push({
        rootEntityId: row.entityId,
        terminalEntityId: partner.terminalEntityId,
        label: partner.terminalLabel,
        edges: [],
      });
    }
  }

  return { roots: [...roots.values()], paths };
}

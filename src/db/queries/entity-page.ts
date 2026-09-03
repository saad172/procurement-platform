import { and, eq, inArray, or } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as t from '@/db/schema';
import { attachRiskSources, parseRiskObject } from '@/domain/scoring/risk-factors';
import { deriveEdgeGroups, deriveKnownAs, deriveOwnerEdges } from '@/domain/derive-entity-page';

/**
 * Everything this page renders, in one read (SPEC §13.1).
 *
 * A page reads through `db/queries`, never through the schema — see
 * `supplier-page.ts` for why.
 */
export async function loadEntityPage(db: Database, args: { programId: string; entityId: string }) {
  const { programId, entityId } = args;

  const entity = await db.query.entity.findFirst({ where: eq(t.entity.id, entityId) });
  if (!entity) return undefined;

  const program = await db.query.program.findFirst({ where: eq(t.program.id, programId) });
  const edges = await db
    .select()
    .from(t.entityRelationship)
    .where(
      or(
        eq(t.entityRelationship.fromEntityId, entityId),
        eq(t.entityRelationship.toEntityId, entityId),
      ),
    );

  /**
   * The body this row was projected from, when this company was fetched on its
   * own. Most were not — they arrived nested in somebody else's traversal — and
   * that absence is stated rather than left as an empty panel.
   */
  const source = entity.upstreamResponseId
    ? await db.query.upstreamResponse.findFirst({
        where: eq(t.upstreamResponse.id, entity.upstreamResponseId),
      })
    : undefined;

  const sources = readSources(entity.sourceCount);
  // With provenance joined back in from the sibling `risk_sources` column
  // (item A) — safe here because this is a page's own render, never a value
  // that reaches a model turn the way `entity.risk` itself sometimes does.
  const factors = attachRiskSources(parseRiskObject(entity.risk), entity.riskSources);
  // Grouped here, not in the Relationships section — a section receives
  // already-derived props; it does not derive.
  const edgeGroups = deriveEdgeGroups(edges, entityId);

  /**
   * The current owners' own labels, for the small list beneath the grouped
   * counts (item C). A second, targeted query rather than a join on `edges`
   * above: most edges on this page are not ownership at all — Yazaki alone
   * carries thousands of `carrier_of` and `notify_party_of` rows — so joining
   * `entity` onto every one of them to label a handful of owners would be
   * the wrong end of the query to widen.
   */
  const ownerTargetIds = [
    ...new Set(
      edges.filter((e) => e.fromEntityId === entityId && !e.former).map((e) => e.toEntityId),
    ),
  ];
  const ownerLabels = ownerTargetIds.length
    ? await db
        .select({ id: t.entity.id, label: t.entity.label })
        .from(t.entity)
        .where(inArray(t.entity.id, ownerTargetIds))
    : [];
  const owners = deriveOwnerEdges(
    edges,
    entityId,
    new Map(ownerLabels.map((row) => [row.id, row.label])),
  );

  const { cases: knownAs, breadcrumbSupplier } = deriveKnownAs(
    await readKnownAsRows(db, programId, entityId),
  );

  return {
    entity,
    program,
    edges,
    edgeGroups,
    owners,
    source,
    sources,
    factors,
    knownAs,
    breadcrumbSupplier,
  };
}

/**
 * The three ways this entity meets a Supplier of this Program — a settled
 * Match, a Corporate family's membership, or a still-open Candidacy — read
 * for `deriveKnownAs()` rather than derived here, so the shaping stays
 * unit-testable apart from Postgres.
 *
 * Every one of the three is scoped to `programId`: `match.entity_id` carries
 * no unique constraint, so a Sayari entity id can belong to a Supplier of the
 * arranged-fixtures Program as readily as to one of this Program, and the
 * Supplier itself is what says which Program it belongs to.
 */
async function readKnownAsRows(db: Database, programId: string, entityId: string) {
  const supplierColumns = {
    id: t.supplier.id,
    rosterName: t.supplier.rosterName,
    rosterIndex: t.supplier.rosterIndex,
    programId: t.supplier.programId,
  };

  const profileMatches = await db
    .select({ status: t.match.status, supplier: supplierColumns })
    .from(t.match)
    .innerJoin(t.supplier, eq(t.supplier.id, t.match.supplierId))
    .where(and(eq(t.match.entityId, entityId), eq(t.supplier.programId, programId)));

  const familyMemberships = await db
    .select({ hopDepth: t.graphPath.hopDepth, supplier: supplierColumns })
    .from(t.graphPath)
    // Rooted at the Supplier's Profile, never at the family member directly
    // — the root is what carries the Match. A Twin is never this join: a
    // Twin carries no Match of its own by definition (CONTEXT.md), so this
    // inner join on `match.entity_id` provably never reaches one.
    .innerJoin(t.match, eq(t.match.entityId, t.graphPath.rootEntityId))
    .innerJoin(t.supplier, eq(t.supplier.id, t.match.supplierId))
    .where(
      and(
        eq(t.graphPath.terminalEntityId, entityId),
        eq(t.graphPath.kind, 'family'),
        eq(t.supplier.programId, programId),
      ),
    );

  const candidacies = await db
    .select({ status: t.match.status, supplier: supplierColumns })
    .from(t.matchCandidate)
    .innerJoin(t.matchAttempt, eq(t.matchAttempt.id, t.matchCandidate.matchAttemptId))
    .innerJoin(t.match, eq(t.match.id, t.matchAttempt.matchId))
    .innerJoin(t.supplier, eq(t.supplier.id, t.match.supplierId))
    .where(and(eq(t.matchCandidate.entityId, entityId), eq(t.supplier.programId, programId)));

  return { profileMatches, familyMemberships, candidacies };
}

/** Reads Sayari's `source_count` blob. A projection of a payload, so it belongs beside the read. */
/**
 * The sources a company is known from, out of `source_count`.
 *
 * The column is an **object keyed by source hash**, and each value carries the
 * source's label, country and kind. The page has always counted its keys for
 * the data-confidence band and shown nothing else, so a reader could see that a
 * company had 38 distinct sources and never which ones.
 *
 * Sorted by mentions, because *45 rows of trade data and one sanctions listing*
 * is a different company from the reverse, and the order is what says so.
 */
function readSources(
  sourceCount: unknown,
): { hash: string; label: string; country: string; sourceType: string; count: number }[] {
  if (!sourceCount || typeof sourceCount !== 'object') return [];

  return Object.entries(sourceCount as Record<string, unknown>)
    .map(([hash, raw]) => {
      const value = (raw ?? {}) as Record<string, unknown>;
      return {
        hash,
        label: typeof value['label'] === 'string' ? value['label'] : hash.slice(0, 12),
        country: typeof value['country'] === 'string' ? value['country'] : '—',
        sourceType: typeof value['source_type'] === 'string' ? value['source_type'] : 'unknown',
        count: typeof value['count'] === 'number' ? value['count'] : 0,
      };
    })
    .sort((a, b) => b.count - a.count);
}

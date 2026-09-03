import type * as t from '@/db/schema';
import { directionOf, targetOwnsSubject } from './relationships';
import { sharePercentageOf } from './parse-relationships';

/**
 * Pure shaping for the Entity page (SPEC §13.7): edges grouped for reading,
 * from the perspective of the company the page is about, and which Suppliers
 * of this Program this entity is already known to.
 *
 * Rows are stored as the payload states them — subject first, target second —
 * so the same row reads differently depending on which end you are standing
 * at. `has_shareholder` on a row where this company is the subject means
 * *somebody owns me*; the identical row seen from the other end means *I own
 * somebody*. Saying which is the entire point of storing direction separately
 * from the name (see `src/domain/relationships.ts`).
 */
export type EdgeGroup = {
  relationshipType: string;
  side: 'from' | 'to';
  reading: string;
  total: number;
  current: number;
  former: number;
};

export function deriveEdgeGroups(
  edges: readonly (typeof t.entityRelationship.$inferSelect)[],
  entityId: string,
): EdgeGroup[] {
  const groups = new Map<
    string,
    { type: string; side: 'from' | 'to'; total: number; current: number; former: number }
  >();

  for (const edge of edges) {
    const side: 'from' | 'to' = edge.fromEntityId === entityId ? 'from' : 'to';
    const key = `${edge.relationshipType}::${side}`;
    const group = groups.get(key) ?? {
      type: edge.relationshipType,
      side,
      total: 0,
      current: 0,
      former: 0,
    };
    group.total += 1;
    if (edge.former) group.former += 1;
    else group.current += 1;
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => {
      const direction = directionOf(group.type);
      // Read from THIS company's end, which flips when it is the target.
      const outward = group.side === 'from';
      const reading =
        direction === 'lateral'
          ? 'neither owns the other'
          : (direction === 'downward') === outward
            ? 'this company is above'
            : 'this company is below';
      return {
        relationshipType: group.type,
        side: group.side,
        reading,
        total: group.total,
        current: group.current,
        former: group.former,
      };
    })
    .sort((a, b) => b.total - a.total);
}

/** One current owner of this entity, with the share and dates the edge carries. */
export type OwnerEdgeRow = {
  relationshipType: string;
  targetId: string;
  targetLabel: string | null;
  sharePercentage: number | null;
  startDate: string | null;
  endDate: string | null;
};

/**
 * This entity's current one-hop owners — `deriveEdgeGroups`'s aggregate
 * counts say *how many* `has_shareholder` edges there are; this says *who*,
 * with the share percentage and dates `parseRelationships` has always stored
 * and nothing had read back (item C, SPEC §16.6).
 *
 * Filtered to `side === 'from'` (this entity is the subject) and
 * `targetOwnsSubject`, the same test `ownersOf` applies to a freshly-parsed
 * payload — an owner edge read off a stored row is the identical question
 * asked of a different source.
 *
 * **Collapsed by (type, target), defensively** (P3, PR #19 review). The
 * writer side (`readOwnerEdges`, `src/jobs/enrich.ts`) now skips a typed
 * traversal edge the window already stored, but this is the render path, and
 * a second row for one owner — from a stale pre-fix write, or from any future
 * writer that does not go through that same care — must not become two
 * "Current owner" rows with colliding React keys. First-seen wins, in the
 * order the rows arrived.
 */
export function deriveOwnerEdges(
  edges: readonly (typeof t.entityRelationship.$inferSelect)[],
  entityId: string,
  labelById: ReadonlyMap<string, string>,
): OwnerEdgeRow[] {
  const seen = new Set<string>();
  const owners: OwnerEdgeRow[] = [];
  for (const edge of edges) {
    if (edge.fromEntityId !== entityId || edge.former || !targetOwnsSubject(edge.relationshipType)) {
      continue;
    }
    const key = `${edge.relationshipType}::${edge.toEntityId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    owners.push({
      relationshipType: edge.relationshipType,
      targetId: edge.toEntityId,
      targetLabel: labelById.get(edge.toEntityId) ?? null,
      sharePercentage: sharePercentageOf(edge.attributes),
      startDate: edge.startDate,
      endDate: edge.endDate,
    });
  }
  return owners;
}

/** The Supplier fields the "known as" line needs — never the whole row. */
export type KnownAsSupplier = {
  id: string;
  rosterName: string | null;
  rosterIndex: number | null;
  programId: string;
};

type MatchStatus = (typeof t.match.$inferSelect)['status'];

/** The one-read query's shape for each of the three ways an entity meets a Supplier. */
type KnownAsRows = {
  profileMatches: readonly { status: MatchStatus; supplier: KnownAsSupplier }[];
  familyMemberships: readonly { hopDepth: number; supplier: KnownAsSupplier }[];
  candidacies: readonly { status: MatchStatus; supplier: KnownAsSupplier }[];
};

/**
 * The entity end of the spine's fourth hop (SPEC §13.1): this Sayari entity
 * read backward, as every Supplier of the Program it is already known to.
 *
 * `entityId` is a Sayari id, not a Supplier id — the same entity can be a
 * Profile for one Supplier, a Family member of another's, and a Candidate
 * still under review for a third, all at once. Ordered the way the Heading
 * reads them out: a Profile settles who it is, a Family member is one hop
 * removed from that settlement, and a Candidate is still an open question.
 */
export type KnownAsCase =
  | { kind: 'profile'; supplier: KnownAsSupplier }
  | { kind: 'family'; supplier: KnownAsSupplier; hopDepth: number }
  | { kind: 'candidate'; supplier: KnownAsSupplier; parked: boolean };

export type KnownAs = {
  cases: KnownAsCase[];
  /**
   * The Supplier the entity page's breadcrumb names, if any. Exactly one
   * Profile case names it; zero names none, and more than one also names
   * none, because `match.entity_id` carries no unique constraint (finding
   * 104) and a breadcrumb has room for one parent, not two. Computed here
   * rather than by `Heading` (`sections.tsx`) so the "exactly one" rule is
   * unit-tested apart from Postgres, the same reason `edgeGroups` is derived
   * in `db/queries/entity-page.ts` rather than in a section.
   */
  breadcrumbSupplier: KnownAsSupplier | null;
};

/**
 * De-duplicated against itself, not merely concatenated. Two rules, and only
 * two: a Candidate a Match went on to accept is read as the Profile it became
 * and not also as the Candidate it once was — one company, one settled
 * answer — while a Family member reached from two different Suppliers'
 * Profiles is a fact about two Corporate families and stays listed for both.
 */
export function deriveKnownAs(rows: KnownAsRows): KnownAs {
  const { profileMatches, familyMemberships, candidacies } = rows;

  /**
   * **Filtered on `status`, not assumed from the join alone.**
   *
   * `readKnownAsRows` (`db/queries/entity-page.ts`) selects every `match` row
   * whose `entity_id` equals this entity, with no `status` condition — it
   * relies on `settleMatch()` never writing `entity_id` for a `needs_review`
   * or `not_found` outcome (SPEC §15.4). That is true today, but nothing
   * short of a `NOT NULL ... CHECK` ties the two columns together at the
   * schema, so a Candidate row could reach here through a future settlement
   * path this function never saw written. Filtering explicitly is what
   * makes "only an accepted Match has a Profile" hold regardless.
   */
  const acceptedProfileMatches = profileMatches.filter((row) => row.status === 'accepted');
  const profileSupplierIds = new Set(acceptedProfileMatches.map((row) => row.supplier.id));
  const profileCases: KnownAsCase[] = acceptedProfileMatches.map((row) => ({
    kind: 'profile',
    supplier: row.supplier,
  }));

  const familyCases: KnownAsCase[] = [...familyMemberships]
    .sort((a, b) => a.hopDepth - b.hopDepth)
    .map((row) => ({ kind: 'family', supplier: row.supplier, hopDepth: row.hopDepth }));

  const seenCandidateSupplierIds = new Set<string>();
  const candidateCases: KnownAsCase[] = [];
  for (const row of candidacies) {
    // Rounds can propose the same entity again in a later attempt, and a
    // Candidate the Match accepted belongs to the Profile list above, not
    // here — both collapse to the one case per Supplier this line shows.
    if (profileSupplierIds.has(row.supplier.id)) continue;
    if (seenCandidateSupplierIds.has(row.supplier.id)) continue;
    seenCandidateSupplierIds.add(row.supplier.id);
    candidateCases.push({
      kind: 'candidate',
      supplier: row.supplier,
      parked: row.status === 'needs_review',
    });
  }

  const cases = [...profileCases, ...familyCases, ...candidateCases];
  return {
    cases,
    breadcrumbSupplier:
      acceptedProfileMatches.length === 1 ? acceptedProfileMatches[0]!.supplier : null,
  };
}

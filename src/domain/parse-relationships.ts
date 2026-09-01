import { directionOf, targetOwnsSubject, unclassifiedTypes } from './relationships';

/**
 * Reads the relationship edges out of a Sayari entity payload (SPEC §3.2).
 *
 * Split from the enrichment that used to inline it so that **the live path and
 * the backfill cannot disagree**: re-projecting 944 stored bodies through a
 * second copy of this logic would be a second chance to get the direction
 * wrong, and the whole point of the exercise is that the first copy did.
 *
 * ## The shape, as it actually arrives
 *
 *     relationships: { data: [ {
 *       target: { id, label, type, … },
 *       former: false,
 *       types: { owner_of: [ { former, record, acquisitionDate, attributes } ] }
 *     } ] }
 *
 * One edge object can carry **several types**, and each type **several
 * occurrences** — a different source record, a different date. One row per
 * occurrence, which is exactly what the table's unique key
 * `(from, to, type, source_record_id)` is shaped for.
 */

export type ParsedEdge = {
  /** The entity whose payload carried this edge. Stored verbatim as `from`. */
  subjectId: string;
  targetId: string;
  targetLabel: string | null;
  /** `company`, `person`, `shipment`, `intellectual_property`… */
  targetType: string | null;
  /** The Sayari name, unmodified — direction is resolved from it, not baked in. */
  relationshipType: string;
  former: boolean;
  startDate: string | null;
  endDate: string | null;
  sourceRecordId: string | null;
  attributes: Record<string, unknown> | null;
  /** The nested entity object, when the payload carried one, for upserting. */
  targetEntity: Record<string, unknown> | null;
};

export type ParseResult = {
  edges: ParsedEdge[];
  /** Types this build does not classify. Reported, never guessed at. */
  unclassified: string[];
};

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function parseRelationships(entity: unknown, subjectId: string): ParseResult {
  const root = (entity ?? {}) as { relationships?: { data?: unknown } };
  const data = root.relationships?.data;
  if (!Array.isArray(data)) return { edges: [], unclassified: [] };

  const edges: ParsedEdge[] = [];
  const seenTypes: string[] = [];

  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue;
    const edge = raw as {
      target?: unknown;
      entity?: unknown;
      former?: unknown;
      types?: unknown;
    };

    /**
     * `target` is usually the nested entity and occasionally just its id. Both
     * are usable — the id is what the row needs — but only an object can be
     * upserted, so the two are kept apart rather than conflated.
     */
    const rawTarget = edge.target ?? edge.entity;
    const targetObject =
      rawTarget && typeof rawTarget === 'object' ? (rawTarget as Record<string, unknown>) : null;
    const targetId = targetObject ? asString(targetObject['id']) : asString(rawTarget);
    if (!targetId) continue;

    const types = edge.types;
    if (!types || typeof types !== 'object') continue;

    for (const [relationshipType, occurrences] of Object.entries(
      types as Record<string, unknown>,
    )) {
      seenTypes.push(relationshipType);
      const list = Array.isArray(occurrences) ? occurrences : [occurrences];

      for (const item of list) {
        const occurrence = (item ?? {}) as Record<string, unknown>;
        edges.push({
          subjectId,
          targetId,
          targetLabel: targetObject ? asString(targetObject['label']) : null,
          targetType: targetObject ? asString(targetObject['type']) : null,
          relationshipType,
          /**
           * `former` sits on the occurrence and again on the edge. Either
           * saying so makes it former — a relationship the payload has twice
           * flagged as ended is not a current one because one of the two
           * copies was omitted.
           */
          former: occurrence['former'] === true || edge.former === true,
          startDate: asString(occurrence['acquisitionDate']) ?? asString(occurrence['startDate']),
          endDate: asString(occurrence['endDate']),
          sourceRecordId: asString(occurrence['record']),
          attributes:
            occurrence['attributes'] && typeof occurrence['attributes'] === 'object'
              ? (occurrence['attributes'] as Record<string, unknown>)
              : null,
          targetEntity: targetObject,
        });
      }
    }
  }

  return { edges, unclassified: unclassifiedTypes(seenTypes) };
}

/**
 * The current one-hop **owners** of the subject.
 *
 * `former` is excluded because a former owner is not an owner, and direction is
 * read from the type table rather than from the name — `owner_of` is the
 * subject owning somebody else and must not appear here.
 */
export function ownersOf(edges: readonly ParsedEdge[]): ParsedEdge[] {
  return edges.filter((edge) => !edge.former && targetOwnsSubject(edge.relationshipType));
}

/** Edges grouped for display: type, direction, and the targets on it. */
export function groupForDisplay(
  edges: readonly ParsedEdge[],
): { relationshipType: string; direction: ReturnType<typeof directionOf>; edges: ParsedEdge[] }[] {
  const byType = new Map<string, ParsedEdge[]>();
  for (const edge of edges) {
    byType.set(edge.relationshipType, [...(byType.get(edge.relationshipType) ?? []), edge]);
  }
  return [...byType.entries()]
    .map(([relationshipType, group]) => ({
      relationshipType,
      direction: directionOf(relationshipType),
      edges: group,
    }))
    .sort((a, b) => b.edges.length - a.edges.length);
}

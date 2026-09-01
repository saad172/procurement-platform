import type * as t from '@/db/schema';
import { directionOf } from './relationships';

/**
 * Pure shaping for the Entity page (SPEC §13.7): edges grouped for reading,
 * from the perspective of the company the page is about.
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

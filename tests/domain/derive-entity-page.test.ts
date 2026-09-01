import { describe, expect, it } from 'vitest';
import { deriveEdgeGroups } from '@/domain/derive-entity-page';

/**
 * Rows are stored as the payload states them — subject first, target second —
 * so the same relationship type reads oppositely depending on which end this
 * company is standing at. That reading, not the count, is what is worth
 * testing here.
 */

const edge = (overrides: Partial<{ relationshipType: string; fromEntityId: string; toEntityId: string; former: boolean }> = {}) => ({
  id: 'e1',
  relationshipType: overrides.relationshipType ?? 'owner_of',
  fromEntityId: overrides.fromEntityId ?? 'SUBJECT',
  toEntityId: overrides.toEntityId ?? 'TARGET',
  former: overrides.former ?? false,
});

describe('deriveEdgeGroups', () => {
  it('reads "this company is above" when the subject owns the target', () => {
    const groups = deriveEdgeGroups([edge({ relationshipType: 'owner_of', fromEntityId: 'SUBJECT', toEntityId: 'TARGET' })] as never, 'SUBJECT');
    expect(groups[0]).toMatchObject({ side: 'from', reading: 'this company is above' });
  });

  it('reads the identical relationship type as "below" from the other end', () => {
    // owner_of is downward — the entity we are standing at is the TARGET here,
    // so being on the receiving end of "owns" means it is owned, not owning.
    const groups = deriveEdgeGroups([edge({ relationshipType: 'owner_of', fromEntityId: 'SUBJECT', toEntityId: 'TARGET' })] as never, 'TARGET');
    expect(groups[0]).toMatchObject({ side: 'to', reading: 'this company is below' });
  });

  it('reads an upward type ("has_shareholder") the opposite way round from a downward one', () => {
    const groups = deriveEdgeGroups(
      [edge({ relationshipType: 'has_shareholder', fromEntityId: 'SUBJECT', toEntityId: 'TARGET' })] as never,
      'SUBJECT',
    );
    expect(groups[0]).toMatchObject({ reading: 'this company is below' });
  });

  it('reads a lateral type as neither owning the other, from either end', () => {
    const groups = deriveEdgeGroups([edge({ relationshipType: 'has_officer' })] as never, 'SUBJECT');
    expect(groups[0]).toMatchObject({ reading: 'neither owns the other' });
  });

  it('groups by type and side, counting current and former separately', () => {
    const edges = [
      edge({ relationshipType: 'owner_of', former: false }),
      edge({ relationshipType: 'owner_of', former: true }),
      edge({ relationshipType: 'owner_of', former: false }),
    ];
    const groups = deriveEdgeGroups(edges as never, 'SUBJECT');
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ total: 3, current: 2, former: 1 });
  });

  it('sorts groups by total, largest first', () => {
    const edges = [
      edge({ relationshipType: 'has_officer' }),
      edge({ relationshipType: 'owner_of' }),
      edge({ relationshipType: 'owner_of', toEntityId: 'TARGET2' }),
    ];
    const groups = deriveEdgeGroups(edges as never, 'SUBJECT');
    expect(groups[0]!.relationshipType).toBe('owner_of');
    expect(groups[0]!.total).toBe(2);
  });
});

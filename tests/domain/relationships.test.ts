import { describe, expect, it } from 'vitest';
import { parseRelationships, ownersOf, sharePercentageOf } from '@/domain/parse-relationships';
import {
  directionOf,
  isOwnership,
  targetOwnsSubject,
  upwardOwnershipTypes,
} from '@/domain/relationships';

/**
 * The shape as Sayari actually sends it — `types` plural, an object keyed by
 * relationship name, each key an array of occurrences. Copied from a stored
 * response, because the bug this guards against was a reader inventing a
 * simpler shape than the one that arrives.
 */
const PAYLOAD = {
  id: 'SUBJECT',
  relationships: {
    data: [
      {
        former: false,
        target: { id: 'TRADEMARK', label: 'SNAP FIT', type: 'intellectual_property' },
        types: {
          owner_of: [
            { former: false, record: 'rec-1', acquisitionDate: '2024-12-31', attributes: {} },
          ],
        },
      },
      {
        former: false,
        target: { id: 'PARENT', label: 'Parent Holdings', type: 'company' },
        types: { has_shareholder: [{ former: false, record: 'rec-2' }] },
      },
      {
        former: false,
        target: { id: 'EX-PARENT', label: 'Former Holdings', type: 'company' },
        types: { has_shareholder: [{ former: true, record: 'rec-3' }] },
      },
      {
        former: false,
        target: { id: 'CHILD', label: 'Child Ltd', type: 'company' },
        types: {
          has_subsidiary: [{ former: false, record: 'rec-4' }],
          // One edge, two types, two occurrences of the second.
          ships_to: [{ record: 'rec-5' }, { record: 'rec-6' }],
        },
      },
    ],
  },
};

describe('reading relationship edges', () => {
  const { edges, unclassified } = parseRelationships(PAYLOAD, 'SUBJECT');

  it('reads `types`, not `type` — the field that was silently absent', () => {
    // Six occurrences: owner_of, has_shareholder ×2, has_subsidiary, ships_to ×2.
    expect(edges).toHaveLength(6);
    expect(edges.map((e) => e.relationshipType)).toContain('owner_of');
  });

  it('stores every edge subject-first, with the type verbatim', () => {
    for (const edge of edges) expect(edge.subjectId).toBe('SUBJECT');
    const trademark = edges.find((e) => e.targetId === 'TRADEMARK')!;
    expect(trademark.relationshipType).toBe('owner_of');
    expect(trademark.targetType).toBe('intellectual_property');
    expect(trademark.sourceRecordId).toBe('rec-1');
    expect(trademark.startDate).toBe('2024-12-31');
  });

  it('splits one edge carrying several types into a row per occurrence', () => {
    const toChild = edges.filter((e) => e.targetId === 'CHILD');
    expect(toChild.map((e) => e.relationshipType).sort()).toEqual([
      'has_subsidiary',
      'ships_to',
      'ships_to',
    ]);
  });

  it('carries `former` from the occurrence, not only from the edge', () => {
    expect(edges.find((e) => e.targetId === 'EX-PARENT')!.former).toBe(true);
  });

  it('classifies every type in this payload', () => {
    expect(unclassified).toEqual([]);
  });
});

describe('which way an edge points', () => {
  /**
   * The whole reason the type table exists. `owner_of` and `has_shareholder`
   * both match /owner|shareholder/ and mean opposite things; 63% of the
   * ownership edges measured point downward, so a reader that took them all as
   * owners would file a company's subsidiaries as its proprietors.
   */
  it('does not mistake what the subject owns for what owns the subject', () => {
    expect(targetOwnsSubject('owner_of')).toBe(false);
    expect(targetOwnsSubject('shareholder_of')).toBe(false);
    expect(targetOwnsSubject('beneficial_owner_of')).toBe(false);
    expect(targetOwnsSubject('has_subsidiary')).toBe(false);

    expect(targetOwnsSubject('has_shareholder')).toBe(true);
    expect(targetOwnsSubject('has_beneficial_owner')).toBe(true);
    expect(targetOwnsSubject('subsidiary_of')).toBe(true);
  });

  it('keeps people and shipments out of ownership entirely', () => {
    for (const type of ['has_officer', 'has_director', 'ships_to', 'carrier_of', 'linked_to']) {
      expect(isOwnership(type)).toBe(false);
      expect(targetOwnsSubject(type)).toBe(false);
    }
  });

  it('treats an unclassified type as lateral and never as an owner', () => {
    expect(directionOf('has_something_new')).toBe('lateral');
    expect(targetOwnsSubject('has_something_new')).toBe(false);
    expect(
      parseRelationships(
        { relationships: { data: [{ target: { id: 'X' }, types: { has_something_new: [{}] } }] } },
        'S',
      ).unclassified,
    ).toEqual(['has_something_new']);
  });
});

describe('owners of the subject', () => {
  const { edges } = parseRelationships(PAYLOAD, 'SUBJECT');

  it('is the current upward ownership edges and nothing else', () => {
    expect(ownersOf(edges).map((e) => e.targetId)).toEqual(['PARENT']);
  });
});

/**
 * The three types the typed owner-edge read asks a traversal for by name
 * (SPEC §16.6, item B) — derived from the same table `targetOwnsSubject`
 * reads, so the two can never name a different set.
 */
describe('upwardOwnershipTypes', () => {
  it('is exactly the three upward ownership types, and no others', () => {
    expect(upwardOwnershipTypes().sort()).toEqual(
      ['has_beneficial_owner', 'has_shareholder', 'subsidiary_of'].sort(),
    );
  });

  it('agrees with targetOwnsSubject about every type in the table', () => {
    for (const type of upwardOwnershipTypes()) {
      expect(targetOwnsSubject(type)).toBe(true);
    }
  });
});

/**
 * `attributes.shares[].percentage` — stored by `parseRelationships` since
 * before this ticket, and never read until item C (SPEC §16.6). Shaped from a
 * real recorded `has_shareholder` occurrence in
 * `tests/fixtures/resolve/rules-r0.json`.
 */
describe('sharePercentageOf', () => {
  it('reads the percentage off a real recorded share occurrence', () => {
    expect(sharePercentageOf({ shares: [{ percentage: 16.3 }] })).toBe(16.3);
  });

  it('is null when there is no shares array at all', () => {
    expect(sharePercentageOf(null)).toBeNull();
    expect(sharePercentageOf({})).toBeNull();
  });

  it('is null when the share entry carries a monetary value but no percentage', () => {
    // A real shape from the same fixture: `{ currency, num_shares }` with no
    // percentage — a share COUNT is not a percentage, and is not read as one.
    expect(sharePercentageOf({ shares: [{ num_shares: 30846 }] })).toBeNull();
  });

  it('takes the first entry that names a percentage, not only the first entry', () => {
    expect(sharePercentageOf({ shares: [{ num_shares: 100 }, { percentage: 6.2 }] })).toBe(6.2);
  });
});

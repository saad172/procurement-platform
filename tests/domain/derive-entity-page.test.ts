import { describe, expect, it } from 'vitest';
import {
  deriveEdgeGroups,
  deriveKnownAs,
  deriveOwnerEdges,
  type KnownAsSupplier,
} from '@/domain/derive-entity-page';

/**
 * Rows are stored as the payload states them — subject first, target second —
 * so the same relationship type reads oppositely depending on which end this
 * company is standing at. That reading, not the count, is what is worth
 * testing here.
 */

const edge = (
  overrides: Partial<{
    relationshipType: string;
    fromEntityId: string;
    toEntityId: string;
    former: boolean;
    attributes: unknown;
    startDate: string | null;
    endDate: string | null;
  }> = {},
) => ({
  id: 'e1',
  relationshipType: overrides.relationshipType ?? 'owner_of',
  fromEntityId: overrides.fromEntityId ?? 'SUBJECT',
  toEntityId: overrides.toEntityId ?? 'TARGET',
  former: overrides.former ?? false,
  attributes: overrides.attributes ?? null,
  startDate: overrides.startDate ?? null,
  endDate: overrides.endDate ?? null,
});

describe('deriveEdgeGroups', () => {
  it('reads "this company is above" when the subject owns the target', () => {
    const groups = deriveEdgeGroups(
      [
        edge({ relationshipType: 'owner_of', fromEntityId: 'SUBJECT', toEntityId: 'TARGET' }),
      ] as never,
      'SUBJECT',
    );
    expect(groups[0]).toMatchObject({ side: 'from', reading: 'this company is above' });
  });

  it('reads the identical relationship type as "below" from the other end', () => {
    // owner_of is downward — the entity we are standing at is the TARGET here,
    // so being on the receiving end of "owns" means it is owned, not owning.
    const groups = deriveEdgeGroups(
      [
        edge({ relationshipType: 'owner_of', fromEntityId: 'SUBJECT', toEntityId: 'TARGET' }),
      ] as never,
      'TARGET',
    );
    expect(groups[0]).toMatchObject({ side: 'to', reading: 'this company is below' });
  });

  it('reads an upward type ("has_shareholder") the opposite way round from a downward one', () => {
    const groups = deriveEdgeGroups(
      [
        edge({
          relationshipType: 'has_shareholder',
          fromEntityId: 'SUBJECT',
          toEntityId: 'TARGET',
        }),
      ] as never,
      'SUBJECT',
    );
    expect(groups[0]).toMatchObject({ reading: 'this company is below' });
  });

  it('reads a lateral type as neither owning the other, from either end', () => {
    const groups = deriveEdgeGroups(
      [edge({ relationshipType: 'has_officer' })] as never,
      'SUBJECT',
    );
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

/**
 * `deriveEdgeGroups` says HOW MANY `has_shareholder` edges there are;
 * `deriveOwnerEdges` says WHO, with the share and dates the edge carries —
 * item C (SPEC §16.6).
 */
describe('deriveOwnerEdges', () => {
  it('is this company’s current owners, and no other side of no other type', () => {
    const edges = [
      // This company is the SUBJECT and has_shareholder is upward: PARENT owns it.
      edge({ relationshipType: 'has_shareholder', fromEntityId: 'SUBJECT', toEntityId: 'PARENT' }),
      // Downward: this company owns CHILD, so CHILD is not an owner of it.
      edge({ relationshipType: 'owner_of', fromEntityId: 'SUBJECT', toEntityId: 'CHILD' }),
      // Standing at the other end: this row is about SUBJECT owning CHILD, so
      // read from CHILD it is not one of CHILD's owner edges either.
      edge({ relationshipType: 'owner_of', fromEntityId: 'OTHER', toEntityId: 'SUBJECT' }),
    ];
    const owners = deriveOwnerEdges(edges as never, 'SUBJECT', new Map());
    expect(owners.map((o) => o.targetId)).toEqual(['PARENT']);
  });

  it('excludes a former owner — only a current edge is an owner', () => {
    const edges = [
      edge({
        relationshipType: 'has_shareholder',
        fromEntityId: 'SUBJECT',
        toEntityId: 'EX-PARENT',
        former: true,
      }),
    ];
    expect(deriveOwnerEdges(edges as never, 'SUBJECT', new Map())).toEqual([]);
  });

  it('carries the share percentage and dates the edge stores', () => {
    const edges = [
      edge({
        relationshipType: 'has_shareholder',
        fromEntityId: 'SUBJECT',
        toEntityId: 'PARENT',
        attributes: { shares: [{ percentage: 16.3 }] },
        startDate: '2024-01-22',
        endDate: null,
      }),
    ];
    const [owner] = deriveOwnerEdges(edges as never, 'SUBJECT', new Map());
    expect(owner).toMatchObject({
      sharePercentage: 16.3,
      startDate: '2024-01-22',
      endDate: null,
    });
  });

  it('names the owner from the label map, or the id when it has none', () => {
    const edges = [
      edge({ relationshipType: 'has_shareholder', fromEntityId: 'SUBJECT', toEntityId: 'PARENT' }),
    ];
    const named = deriveOwnerEdges(
      edges as never,
      'SUBJECT',
      new Map([['PARENT', 'Parent Holdings']]),
    );
    expect(named[0]!.targetLabel).toBe('Parent Holdings');

    const unnamed = deriveOwnerEdges(edges as never, 'SUBJECT', new Map());
    expect(unnamed[0]!.targetLabel).toBeNull();
  });
});

/**
 * `deriveKnownAs` reads the entity end of the spine backward: every Supplier
 * of this Program the entity is already known to, as a Profile, a Family
 * member or a Candidate. The de-dup rules and the ordering are the point —
 * the kinds themselves are a thin wrapper over the query's own rows.
 */
const knownAsSupplier = (overrides: Partial<KnownAsSupplier> = {}): KnownAsSupplier => ({
  id: overrides.id ?? 'SUP1',
  rosterName: overrides.rosterName ?? 'Aptiv',
  rosterIndex: overrides.rosterIndex ?? 11,
  programId: overrides.programId ?? 'PROGRAM1',
});

describe('deriveKnownAs', () => {
  it('reads a settled Match as the profile case', () => {
    const { cases } = deriveKnownAs({
      profileMatches: [{ status: 'accepted', supplier: knownAsSupplier() }],
      familyMemberships: [],
      candidacies: [],
    });
    expect(cases).toEqual([{ kind: 'profile', supplier: knownAsSupplier() }]);
  });

  it('reads a family_member row as the family case, carrying its hop depth', () => {
    const bosch = knownAsSupplier({ id: 'SUP2', rosterName: 'Bosch', rosterIndex: 4 });
    const { cases } = deriveKnownAs({
      profileMatches: [],
      familyMemberships: [{ hopDepth: 2, supplier: bosch }],
      candidacies: [],
    });
    expect(cases).toEqual([{ kind: 'family', supplier: bosch, hopDepth: 2 }]);
  });

  it('reads an open Candidacy as the candidate case, parked when its Match is needs_review', () => {
    const nsk = knownAsSupplier({ id: 'SUP3', rosterName: 'NSK', rosterIndex: 9 });
    const { cases } = deriveKnownAs({
      profileMatches: [],
      familyMemberships: [],
      candidacies: [{ status: 'needs_review', supplier: nsk }],
    });
    expect(cases).toEqual([{ kind: 'candidate', supplier: nsk, parked: true }]);
  });

  it('reads a settled Candidacy (status accepted) as not parked', () => {
    const { cases } = deriveKnownAs({
      profileMatches: [],
      familyMemberships: [],
      candidacies: [{ status: 'accepted', supplier: knownAsSupplier() }],
    });
    expect(cases[0]).toMatchObject({ parked: false });
  });

  it('returns the empty list for an entity known to no Supplier in this Program', () => {
    const { cases } = deriveKnownAs({ profileMatches: [], familyMemberships: [], candidacies: [] });
    expect(cases).toEqual([]);
  });

  it('excludes a profileMatches row whose Match is not accepted — only a settled Match has a Profile', () => {
    // Guards deriveKnownAs's own filter (see its comment): readKnownAsRows
    // selects on entity_id alone, and settleMatch is what is trusted to
    // leave entity_id null on every non-accepted outcome, not this function.
    const { cases } = deriveKnownAs({
      profileMatches: [{ status: 'needs_review', supplier: knownAsSupplier() }],
      familyMemberships: [],
      candidacies: [],
    });
    expect(cases).toEqual([]);
  });

  it('drops a Candidate that the same Supplier’s Match went on to accept — it is only the Profile', () => {
    const supplier = knownAsSupplier();
    const { cases } = deriveKnownAs({
      profileMatches: [{ status: 'accepted', supplier }],
      familyMemberships: [],
      candidacies: [{ status: 'accepted', supplier }],
    });
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ kind: 'profile' });
  });

  it('collapses repeat Candidacy rows for one Supplier (a later Round proposing it again)', () => {
    const supplier = knownAsSupplier();
    const { cases } = deriveKnownAs({
      profileMatches: [],
      familyMemberships: [],
      candidacies: [
        { status: 'needs_review', supplier },
        { status: 'needs_review', supplier },
      ],
    });
    expect(cases).toHaveLength(1);
  });

  it('lists a Family member for each Supplier whose Profile roots it, when two Suppliers share the member', () => {
    const bosch = knownAsSupplier({ id: 'SUP2', rosterName: 'Bosch' });
    const magna = knownAsSupplier({ id: 'SUP4', rosterName: 'Magna' });
    const { cases } = deriveKnownAs({
      profileMatches: [],
      familyMemberships: [
        { hopDepth: 1, supplier: bosch },
        { hopDepth: 3, supplier: magna },
      ],
      candidacies: [],
    });
    expect(cases.map((c) => c.supplier.rosterName)).toEqual(['Bosch', 'Magna']);
  });

  it('orders Profiles first, then Family by hop depth ascending, then Candidates', () => {
    const profile = knownAsSupplier({ id: 'SUP1', rosterName: 'Aptiv' });
    const deepFamily = knownAsSupplier({ id: 'SUP2', rosterName: 'Deep' });
    const shallowFamily = knownAsSupplier({ id: 'SUP3', rosterName: 'Shallow' });
    const candidate = knownAsSupplier({ id: 'SUP4', rosterName: 'NSK' });
    const { cases } = deriveKnownAs({
      profileMatches: [{ status: 'accepted', supplier: profile }],
      familyMemberships: [
        { hopDepth: 3, supplier: deepFamily },
        { hopDepth: 1, supplier: shallowFamily },
      ],
      candidacies: [{ status: 'needs_review', supplier: candidate }],
    });
    expect(cases.map((c) => c.supplier.rosterName)).toEqual(['Aptiv', 'Shallow', 'Deep', 'NSK']);
  });

  it('names breadcrumbSupplier only when exactly one Profile case exists — two Profiles name none', () => {
    // match.entity_id carries no unique constraint (finding 104): a Sayari
    // entity can be two Suppliers' Profile, and a breadcrumb has room for
    // one parent, not two.
    const aptiv = knownAsSupplier({ id: 'SUP1', rosterName: 'Aptiv' });
    const oneProfile = deriveKnownAs({
      profileMatches: [{ status: 'accepted', supplier: aptiv }],
      familyMemberships: [],
      candidacies: [],
    });
    expect(oneProfile.breadcrumbSupplier).toEqual(aptiv);

    const bosch = knownAsSupplier({ id: 'SUP2', rosterName: 'Bosch' });
    const twoProfiles = deriveKnownAs({
      profileMatches: [
        { status: 'accepted', supplier: aptiv },
        { status: 'accepted', supplier: bosch },
      ],
      familyMemberships: [],
      candidacies: [],
    });
    expect(twoProfiles.breadcrumbSupplier).toBeNull();

    const noProfile = deriveKnownAs({ profileMatches: [], familyMemberships: [], candidacies: [] });
    expect(noProfile.breadcrumbSupplier).toBeNull();
  });
});

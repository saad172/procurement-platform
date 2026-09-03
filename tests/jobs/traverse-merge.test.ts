import { describe, expect, it } from 'vitest';
import { mergeMembers, type MergedPathMember } from '@/jobs/traverse';
import { ownershipHopDepth, summarisePath, terminalEntityOf } from '@/jobs/family-members';
import type { SayariTraversalPath } from '@/upstream/projections/sayari';

/**
 * The Deep Traversal's arithmetic, over synthetic envelopes (SPEC §8.5,
 * network spec §6).
 *
 * Everything a walk decides that is not *"ask for another page"* happens in
 * `mergeMembers`: which path terminal is a Path's terminal, how many hops away
 * it is, whether we already hold it, and when the node cap says stop. None of
 * it needs a database or a credential, and none of it is visible in a recorded
 * fixture — a recording freezes one answer and cannot show that a *different*
 * envelope would have been merged correctly.
 *
 * The hop rule is the one worth stating twice: **a `possibly_same_as` step is
 * not an ownership hop.** SPEC §8.1 measured the family as psa-routed, so
 * counting path length would report a direct subsidiary reached through two
 * `possibly_same_as` hops to other records of the same company as three hops
 * away — and the hop number is what the Supplier page now renders beside every
 * member's name.
 */

const ROOT = 'root-entity';

/** A path ending at `id`, through the named relationship fields. */
function path(id: string, fields: string[]): SayariTraversalPath {
  return {
    source: ROOT,
    target: { id, label: id.toUpperCase() },
    path: fields.map((field, index) => ({
      field,
      entity: { id: `${id}-hop${index}`, label: field },
      relationships: {},
    })),
  } as SayariTraversalPath;
}

const held = () => new Map<string, MergedPathMember>();
const bounds = { maxNodes: 200, maxHops: 3 };

describe('what one page of a walk contributes', () => {
  it('counts ownership hops and does not count possibly_same_as', () => {
    // The measured shape: Sayari splits a company across records and the
    // ownership hangs off the others, so a path runs sideways before it runs
    // down. Two sideways steps and one down is ONE hop of ownership.
    expect(ownershipHopDepth(path('a', ['shareholder_of']).path)).toBe(1);
    expect(
      ownershipHopDepth(path('b', ['possibly_same_as', 'possibly_same_as', 'shareholder_of']).path),
    ).toBe(1);
    expect(ownershipHopDepth(path('c', ['shareholder_of', 'has_branch']).path)).toBe(2);
    expect(
      ownershipHopDepth(path('d', ['shareholder_of', 'possibly_same_as', 'has_subsidiary']).path),
    ).toBe(2);
  });

  it('floors at one hop, because nothing is zero hops from the root', () => {
    expect(ownershipHopDepth([])).toBe(1);
    expect(ownershipHopDepth(undefined)).toBe(1);
    expect(ownershipHopDepth(path('e', ['possibly_same_as']).path)).toBe(1);
  });

  it('merges a page and records each member at the hop that reached it', () => {
    const map = held();
    const added = mergeMembers({
      rootEntityId: ROOT,
      held: map,
      paths: [path('a', ['shareholder_of']), path('b', ['shareholder_of', 'has_branch'])],
      ...bounds,
    });
    expect(added.map((m) => [m.entity.id, m.hopDepth])).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
    expect(map.size).toBe(2);
  });

  it('keeps the FIRST find, so the two directions compose into one cap', () => {
    const map = held();
    mergeMembers({
      rootEntityId: ROOT,
      held: map,
      paths: [path('a', ['has_subsidiary'])],
      ...bounds,
    });

    // The upward walk reaches the same company two hops away. It is one
    // terminal at hop 1, not two rows and not a demotion to hop 2.
    const added = mergeMembers({
      rootEntityId: ROOT,
      held: map,
      paths: [path('a', ['subsidiary_of', 'has_shareholder']), path('z', ['has_shareholder'])],
      ...bounds,
    });

    expect(added.map((m) => m.entity.id)).toEqual(['z']);
    expect(map.size).toBe(2);
    expect(map.get('a')?.hopDepth).toBe(1);
  });

  it('drops a page’s duplicates as well as the ones it already held', () => {
    const map = held();
    const added = mergeMembers({
      rootEntityId: ROOT,
      held: map,
      paths: [path('a', ['has_branch']), path('a', ['has_branch', 'has_branch'])],
      ...bounds,
    });
    expect(added).toHaveLength(1);
    expect(map.size).toBe(1);
  });

  it('never records the root as a member of its own family', () => {
    const map = held();
    const added = mergeMembers({
      rootEntityId: ROOT,
      held: map,
      paths: [path(ROOT, ['possibly_same_as']), path('a', ['has_branch'])],
      ...bounds,
    });
    expect(added.map((m) => m.entity.id)).toEqual(['a']);
  });

  it('stops merging at the node cap, mid-page', () => {
    const map = held();
    const added = mergeMembers({
      rootEntityId: ROOT,
      held: map,
      paths: ['a', 'b', 'c', 'd'].map((id) => path(id, ['has_subsidiary'])),
      maxNodes: 2,
      maxHops: 3,
    });
    // A cap counted in members rather than in pages: the third path is refused
    // even though the page it arrived on was already paid for.
    expect(added.map((m) => m.entity.id)).toEqual(['a', 'b']);
    expect(map.size).toBe(2);
  });

  it('refuses a path deeper than the hop cap even though the request set one', () => {
    const map = held();
    const added = mergeMembers({
      rootEntityId: ROOT,
      held: map,
      paths: [
        path('deep', ['has_subsidiary', 'has_subsidiary', 'has_subsidiary', 'has_subsidiary']),
        path('ok', ['has_subsidiary', 'possibly_same_as', 'has_subsidiary', 'has_subsidiary']),
      ],
      ...bounds,
    });
    // The second is four steps long and three of them are ownership, so it is
    // inside the cap. The hop cap is true of what is STORED, not only of what
    // was asked for.
    expect(added.map((m) => m.entity.id)).toEqual(['ok']);
  });

  it('stores the route, never the entities along it', () => {
    const map = held();
    const [member] = mergeMembers({
      rootEntityId: ROOT,
      held: map,
      paths: [path('a', ['possibly_same_as', 'has_subsidiary'])],
      ...bounds,
    });
    // 886 KB across 17 rows is what storing the hop entities cost, and one path
    // alone was 605 KB — a traversal payload carries a complete entity at every
    // hop (BUILD-NOTES finding 23). `hops` carries the route (field, entity id,
    // cumulative hop depth) and the edge each hop names — never the entity.
    expect(member!.hops.map((h) => ({ field: h.field, entityId: h.entityId }))).toEqual([
      { field: 'possibly_same_as', entityId: 'a-hop0' },
      { field: 'has_subsidiary', entityId: 'a-hop1' },
    ]);
    // Every hop resolved to a citable edge here, chained root → hop0 → hop1.
    expect(member!.hops.map((h) => [h.edge?.subjectId, h.edge?.targetId])).toEqual([
      [ROOT, 'a-hop0'],
      ['a-hop0', 'a-hop1'],
    ]);
  });

  it('falls back to the last hop when a path carries no target entity', () => {
    const bare = { source: ROOT, path: [{ field: 'has_branch', entity: { id: 'tail' } }] };
    expect(terminalEntityOf(bare as SayariTraversalPath, ROOT)?.id).toBe('tail');
    const hops = summarisePath(bare.path, ROOT);
    expect(hops.map((h) => ({ field: h.field, entityId: h.entityId }))).toEqual([
      { field: 'has_branch', entityId: 'tail' },
    ]);
  });
});

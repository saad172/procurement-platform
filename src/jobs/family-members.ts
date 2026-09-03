import { sql } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as t from '@/db/schema';
import type { EntitySource, FamilyMemberRisk } from '@/domain/family';
import { parseRiskObject } from '@/domain/scoring/risk-factors';
import type { SayariEntity, SayariTraversalPath } from '@/upstream/projections/sayari';
import { upsertEntity } from './resolve';

/**
 * Writing `family_member` rows, for both reads that produce them (SPEC §8.5).
 *
 * **Two callers, one writer.** The automatic Corporate family read
 * (`enrichFamily`) and the person-triggered Deep Traversal (`runDeepTraversal`)
 * find members through different endpoints, at different depths, in different
 * directions — and then have exactly the same thing to say about each one:
 * upsert the entity, and record the pair *(root, member)* with the route that
 * reached it. SPEC §8.5 is explicit that a Deep Traversal *writes into the same
 * `family_member` table*, so the second caller could only have been a copy of
 * the first, and a copy is where the `onConflictDoUpdate` target would have
 * drifted back to the primary key that already cost Bosch and Magna a doubled
 * badge.
 *
 * What stays with each caller is what genuinely differs: which endpoint to
 * call, how to page it, and how to read coverage off its envelope. What lives
 * here is the row.
 */

/** One member, ready to write: the entity as it arrived, and the route to it. */
export type FamilyMemberWrite = {
  entity: SayariEntity;
  /** The **shape** of the path, never the entities along it — see `summarisePath`. */
  path: unknown;
  hopDepth: number;
};

/**
 * Upserts every member and its entity, and returns them in the shape the
 * Family exposure badge reads.
 *
 * `discoveredByJob` is the caller's answer to *which read found this*: null for
 * the automatic family, the Job id for a Deep Traversal. It is deliberately
 * **not** in the conflict `set` below.
 *
 * `source` names the endpoint this batch of members arrived from, for the risk
 * union `upsertEntity` merges on every write (SPEC §8.2 D5). Left unnamed, it
 * defaults to `'ownership'` when `discoveredByJob` is null — the automatic
 * family read, which always calls `traversal.ownership` — and to `'ubo'`
 * otherwise, because a Deep Traversal is the one caller that also walks
 * upward. `traverse.ts` is not this ticket's file to edit, so its existing
 * call (which names neither) still gets a sensible label rather than the
 * wrong one (`getEntity`) `upsertEntity`'s own default would otherwise apply.
 */
export async function writeFamilyMembers(
  db: Database,
  args: {
    rootEntityId: string;
    enrichmentId: string;
    members: readonly FamilyMemberWrite[];
    coverage: { truncated: boolean; exploredCount: number | null; reachableCount: number | null };
    discoveredByJob: string | null;
    source?: EntitySource | undefined;
  },
): Promise<FamilyMemberRisk[]> {
  const written: FamilyMemberRisk[] = [];
  const source: EntitySource = args.source ?? (args.discoveredByJob ? 'ubo' : 'ownership');

  for (const member of args.members) {
    // The merged, persisted `risk` — the union of this sighting and whatever
    // this id already held, with per-factor provenance — rather than the
    // fresh incoming payload alone. Reading it straight back from the write
    // is what lets a Family member get the same "provenance from the stored
    // row" treatment as the five other single-source call sites (item A):
    // one member entity can be BOTH a Supplier's Profile (fetched by
    // `getEntity` elsewhere) and a family member (fetched by this traversal),
    // and the badge should see everything either read has ever found.
    const { risk: storedRisk } = await upsertEntity(db, member.entity, undefined, source);
    await db
      .insert(t.familyMember)
      .values({
        enrichmentId: args.enrichmentId,
        rootEntityId: args.rootEntityId,
        memberEntityId: member.entity.id,
        path: (member.path ?? null) as never,
        hopDepth: member.hopDepth,
        discoveredByJob: args.discoveredByJob,
        truncated: args.coverage.truncated,
        exploredCount: args.coverage.exploredCount,
        reachableCount: args.coverage.reachableCount,
      })
      .onConflictDoUpdate({
        target: [t.familyMember.rootEntityId, t.familyMember.memberEntityId],
        set: conflictSet(args),
      });

    written.push({
      entityId: member.entity.id,
      label: member.entity.label,
      country: member.entity.countries?.[0] ?? null,
      factors: parseRiskObject(storedRisk ?? member.entity.risk),
      hopDepth: member.hopDepth,
      fromDeepTraversal: args.discoveredByJob != null,
    });
  }

  return written;
}

/**
 * What a second read of the same pair updates, and what it leaves standing.
 *
 * **`firstSeenAt` and `discoveredByJob` are absent on purpose.** They are the
 * row's provenance — *when this company first appeared in this family, and
 * which read put it there* — and a later read is not new provenance for a fact
 * it did not discover. The *new evidence* chip is computed from `firstSeenAt`
 * (SPEC §12.1), so re-stamping it would light the chip on every re-read; and a
 * Deep Traversal that re-reaches a member the automatic family already held
 * must not claim to have found it.
 *
 * **`hopDepth` and `path` move together, and only downwards.** A row records
 * the *shortest* route known to that member: a company reachable in one hop is
 * reachable in one hop whichever read noticed, and a Deep Traversal arriving at
 * it through a longer path has learned nothing that makes it further away. The
 * path is the evidence for the depth, so overwriting one without the other
 * would leave a row whose route and whose number disagree.
 *
 * The coverage columns *are* overwritten, because they describe the read rather
 * than the member, and the newest read is the one the page should be quoting.
 */
function conflictSet(args: {
  enrichmentId: string;
  coverage: { truncated: boolean; exploredCount: number | null; reachableCount: number | null };
}) {
  return {
    enrichmentId: args.enrichmentId,
    hopDepth: sql`least(${t.familyMember.hopDepth}, excluded.hop_depth)`,
    path: sql`case when excluded.hop_depth <= ${t.familyMember.hopDepth}
                   then excluded.path else ${t.familyMember.path} end`,
    truncated: args.coverage.truncated,
    exploredCount: args.coverage.exploredCount,
    reachableCount: args.coverage.reachableCount,
  };
}

/**
 * Reduces a traversal path to its route: one entry per hop, carrying the
 * relationship field and the entity id it reached.
 *
 * The entities themselves are upserted into `entity` by `writeFamilyMembers`,
 * so storing them again here would duplicate megabytes per Supplier — measured
 * at **886 KB across 17 rows**, one path alone at 605 KB, because a Sayari
 * traversal payload carries a complete entity at every hop. Returning them
 * wholesale from a read tool is what fired the assess Job's 450,000-token
 * ceiling (BUILD-NOTES finding 23).
 */
export function summarisePath(path: unknown): { field: string | null; entityId: string | null }[] {
  if (!Array.isArray(path)) return [];
  return path.map((hop) => {
    const step = (hop ?? {}) as { field?: unknown; entity?: unknown };
    const entity = step.entity;
    return {
      field: typeof step.field === 'string' ? step.field : null,
      entityId:
        typeof entity === 'string'
          ? entity
          : entity && typeof entity === 'object' && 'id' in entity
            ? String((entity as { id: unknown }).id)
            : null,
    };
  });
}

/**
 * A path's depth in **ownership** hops, which is not its length.
 *
 * SPEC §8.1 measured the family as *psa-routed*: every path runs through one or
 * two `possibly_same_as` hops to other records of the same company, because
 * Sayari splits a company across records and the ownership hangs off the
 * others. A `possibly_same_as` step is therefore a move sideways between two
 * records of one company — not a step down the ownership chain — and counting
 * it would report a direct subsidiary reached through two psa hops as three
 * hops away. In the recorded Yazaki family, `possibly_same_as` appears as a
 * path `field` three times, so this is a real difference and not a hypothetical
 * one.
 *
 * Floored at 1, because a member is never zero hops from the root: the root is
 * not its own family member, and a path we cannot read at all is at least one
 * step away.
 */
export function ownershipHopDepth(path: SayariTraversalPath['path']): number {
  if (!Array.isArray(path)) return 1;
  const owned = path.filter((hop) => hop?.field !== 'possibly_same_as').length;
  return Math.max(1, owned);
}

/**
 * The member a path ends at, or nothing where the payload does not carry one.
 *
 * The `target` is the family member and it arrives **complete, with its `risk`
 * block inline** — the measurement that made the family cost one call rather
 * than 25 (SPEC §8.1). Falling back to the last path element covers the shape
 * where `target` is an id rather than an entity; a root that appears as its own
 * target is dropped, since a company is not in its own Corporate family.
 */
export function terminalEntityOf(
  path: SayariTraversalPath,
  rootEntityId: string,
): SayariEntity | undefined {
  const terminal = path.target ?? path.path?.[path.path.length - 1]?.entity;
  if (!terminal || typeof terminal !== 'object' || !('id' in terminal)) return undefined;
  const entity = terminal as SayariEntity;
  return entity.id === rootEntityId ? undefined : entity;
}

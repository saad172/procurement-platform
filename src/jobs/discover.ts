import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as t from '@/db/schema';
import { DISCOVER_CLASSIFY_TOP_N, DISCOVER_TRADE_LIMIT, JOB_CAPS } from '@/config/constants';
import {
  decideLeadRelation,
  prefilterScore,
  programTerritories,
  readLeadClassification,
  type LeadClassificationOutcome,
  type LeadRelationDecision,
  type RosterSupplier,
} from '@/domain/discover-leads';
import { hsHeading } from '@/domain/hs-code';
import { runLoop } from '@/model';
import { toRunnableTools } from '@/model/tool-adapter';
import * as classifierPrompts from '@/model/prompts/classifier';
import { getRegistry, type ToolContext } from '@/tools';
import type { ModelContext } from '@/model/types';
import type { Upstream } from '@/upstream';
import { attributeTexts, type SayariEntity } from '@/upstream/projections/sayari';
import { upsertEntity } from './resolve';

/**
 * Discover (SPEC §11) — the search for companies on no imported list.
 *
 * **Category-seeded only.** Peer-seeding died on a fact rather than an
 * argument: the approved seed names no buyer company, so there is **no OEM
 * entity to seed from**.
 *
 * **Discover proposes and never adds.** A person promotes a Lead into a
 * Supplier; the app has no path that does it unasked.
 */

export type DiscoverDeps = {
  db: Database;
  upstream: Upstream;
  toolCtx: ToolContext;
  modelCtx: ModelContext;
  jobId?: string | undefined;
};

export type DiscoverResult = {
  proposed: number;
  classified: number;
  /** Rows already on the roster, dropped by exact entity-id dedupe. */
  alreadyOnRoster: number;
};

export async function discoverLeads(
  deps: DiscoverDeps,
  args: { programId: string; categoryId: string },
): Promise<DiscoverResult> {
  const { db } = deps;
  const loaded = await loadDiscoverQuery(db, args);
  if (loaded.result) return loaded.result;

  const search = await searchTradeCandidates(deps, args, loaded.query);
  const { classified } = await classifyAndRecordLeads(deps, args, loaded.query, search);

  return { proposed: search.ranked.length, classified, alreadyOnRoster: search.alreadyOnRoster };
}

type DiscoverQuery = { hsCodes: string[]; arrivalCountries: string[] };

/** The Category's HS lines and the Program's territories, or the no-op result if there are none. */
async function loadDiscoverQuery(
  db: Database,
  args: { programId: string; categoryId: string },
): Promise<{ result: DiscoverResult } | { result: null; query: DiscoverQuery }> {
  const lines = await db
    .select()
    .from(t.categoryHsLine)
    .where(eq(t.categoryHsLine.categoryId, args.categoryId));
  if (lines.length === 0) return { result: { proposed: 0, classified: 0, alreadyOnRoster: 0 } };

  const program = await db.query.program.findFirst({ where: eq(t.program.id, args.programId) });
  const plants = await db
    .select({ country: t.plant.country })
    .from(t.plant)
    .where(eq(t.plant.programId, args.programId))
    .orderBy(asc(t.plant.code));

  /**
   * Shipments arriving in **the Sourcing Program's territories** (SPEC §11).
   *
   * The second entry used to be the literal `'MEX'`, which for a Program
   * importing into Mexico asked for `['MEX', 'MEX']`. It is the Plants:
   * `programTerritories` derives the list from the importing country the
   * Program declares plus the countries its Plants sit in, deduped. For the
   * founding Program that is `['USA', 'MEX']` — the same query, from rows a
   * person authored rather than from a constant in a query builder.
   */
  const arrivalCountries = programTerritories(program, plants);

  /**
   * Trade data indexes HS at **six digits**, so the seed's 8- and 10-digit
   * lines are widened to their heading here rather than sent whole.
   *
   * That widening is worth stating, because it is the source of the noise this
   * job exists to handle: `8507.60` is *any* lithium-ion battery, not a
   * traction pack, which is exactly why the top of the result set is freight
   * forwarders and consumer-battery sellers. `hsHeading` is where the rule
   * lives and where it is tested against the seed's own lines — it was a
   * `slice(0, 6)` here and a `startsWith` in the tariff Enrichment, two
   * unnamed halves of one idea.
   */
  const hsCodes = [...new Set(lines.map((line) => hsHeading(line.hsCode)))];

  return { result: null, query: { hsCodes, arrivalCountries } };
}

type RankedCandidates = {
  ranked: { entity: SayariEntity; shipments: number | null; latestShipmentDate: string | null }[];
  alreadyOnRoster: number;
  /** Family member entity id → the Supplier of THIS Program whose family holds it. */
  familyOwners: Map<string, string>;
  roster: RosterSupplier[];
};

/** Runs the trade search, then ranks and dedupes it against the roster. */
async function searchTradeCandidates(
  deps: DiscoverDeps,
  args: { programId: string },
  query: DiscoverQuery,
): Promise<RankedCandidates> {
  const { db } = deps;
  const { hsCodes, arrivalCountries } = query;

  const trade = await deps.upstream.sayari.tradeSearchSuppliers({
    hsCodes,
    arrivalCountries,
    limit: DISCOVER_TRADE_LIMIT,
  });

  // Everything already on this Program's roster, by entity id.
  const onRoster = new Set(
    (
      await db
        .select({ entityId: t.match.entityId })
        .from(t.match)
        .innerJoin(t.supplier, eq(t.supplier.id, t.match.supplierId))
        .where(eq(t.supplier.programId, args.programId))
    )
      .map((row) => row.entityId)
      .filter((id): id is string => id != null),
  );

  // The roster, in roster order, so the name-token flag resolves to the same
  // Supplier every run rather than to whichever row Postgres reached first.
  const roster = await db
    .select({ supplierId: t.supplier.id, rosterName: t.supplier.rosterName })
    .from(t.supplier)
    .where(eq(t.supplier.programId, args.programId))
    .orderBy(asc(t.supplier.rosterIndex));

  const familyOwners = await loadFamilyOwners(db, args.programId);

  const rows = trade.data.data ?? [];
  let alreadyOnRoster = 0;
  const candidates: {
    entity: SayariEntity;
    shipments: number | null;
    latestShipmentDate: string | null;
  }[] = [];

  /**
   * Each row IS an entity; the trade figures hang off `metadata`.
   *
   * Note what is deliberately *not* read here: every row carries Sayari's own
   * `logistics_entity` flag, and neither the ranking nor the classifier sees
   * it. Sorting on it would answer the question with the graph's own label
   * instead of the model's, and dropping on it would delete the forwarders
   * before the classifier ever met one — which is the whole thing this loop
   * exists to demonstrate.
   *
   * It is used in exactly one place: as the ground truth `pnpm check:prefilter`
   * grades the name heuristic against, offline, where it decides nothing.
   */
  for (const row of rows) {
    // Exact entity-id dedupe. Anything softer is a NAME FLAG, never a removal.
    if (onRoster.has(row.id)) {
      alreadyOnRoster += 1;
      continue;
    }
    candidates.push({
      entity: row as SayariEntity,
      shipments: row.metadata.shipments,
      // Absent on some rows, so it is a DISPLAYED COLUMN and never a filter —
      // filtering on it would silently drop every row that lacks one.
      latestShipmentDate: row.metadata.latest_shipment_date ?? null,
    });
  }

  const ranked = candidates
    .sort(
      (a, b) =>
        prefilterScore(b.entity.label) - prefilterScore(a.entity.label) ||
        (b.shipments ?? 0) - (a.shipments ?? 0),
    )
    .slice(0, DISCOVER_CLASSIFY_TOP_N);

  return { ranked, alreadyOnRoster, familyOwners, roster };
}

/** Classifies each ranked candidate and records it as a Lead. */
async function classifyAndRecordLeads(
  deps: DiscoverDeps,
  args: { programId: string; categoryId: string },
  query: DiscoverQuery,
  search: RankedCandidates,
): Promise<{ classified: number }> {
  const { db } = deps;
  const { ranked, familyOwners, roster } = search;
  let classified = 0;

  for (const candidate of ranked) {
    await upsertEntity(db, candidate.entity);

    const outcome = readLeadClassification(await classifyCandidate(deps, query, candidate));
    if (outcome.classification) classified += 1;

    await recordLead(db, {
      programId: args.programId,
      categoryId: args.categoryId,
      candidate,
      query,
      classification: outcome,
      relation: decideLeadRelation(
        { entityId: candidate.entity.id, label: candidate.entity.label },
        { familyOwners, roster },
      ),
      jobId: deps.jobId,
    });
  }

  return { classified };
}

/**
 * One classifier loop over one trade row.
 *
 * The classifier costs **zero additional Sayari calls**: a trade result is
 * already a full entity, so everything the prompt names is in hand.
 */
async function classifyCandidate(
  deps: DiscoverDeps,
  query: DiscoverQuery,
  candidate: RankedCandidates['ranked'][number],
) {
  const classifierTool = getRegistry().byName.get('submit_lead_classification')!;
  return runLoop(
    {
      loop: 'classifier',
      system: classifierPrompts.system,
      tools: toRunnableTools([classifierTool], deps.toolCtx),
      messages: [
        {
          role: 'user',
          content: classifierPrompts.buildFirstUserMessage({
            companyName: candidate.entity.label,
            countries: candidate.entity.countries ?? [],
            shipmentCount: candidate.shipments,
            topHsCodes: query.hsCodes,
            businessPurpose: attributeTexts(
              candidate.entity.attributes?.business_purpose?.data,
            ).join('; '),
            addresses: candidate.entity.addresses ?? [],
          }),
        },
      ],
      caps: JOB_CAPS.discover,
    },
    deps.modelCtx,
  );
}

/**
 * Writes one Lead, with everything that was decided about it.
 *
 * Separated from the loop above so the write can be exercised without a model:
 * `discoverLeads` runs a classifier per candidate and cannot replay offline,
 * and the two facts most worth pinning — that the name-token flag is stored
 * and that the related Supplier is named — are on this row rather than in the
 * loop. `void nameFlag` and a hardcoded `relatedSupplierId: null` is what a
 * value computed near an insert and never written into it looks like.
 */
export async function recordLead(
  db: Database,
  args: {
    programId: string;
    categoryId: string;
    candidate: RankedCandidates['ranked'][number];
    query: DiscoverQuery;
    classification: LeadClassificationOutcome;
    relation: LeadRelationDecision;
    jobId?: string | undefined;
  },
): Promise<void> {
  await db
    .insert(t.lead)
    .values({
      programId: args.programId,
      categoryId: args.categoryId,
      entityId: args.candidate.entity.id,
      // A closed enum, so AN ENUM IS NOT A CLAIM — which is what lets Discover
      // add a table and NO NEW CITATION TARGET GROUP. The reasoning stays
      // inspectable in the trace and no sentence is written from it.
      //
      // Null rather than `unclear` when the classifier produced nothing:
      // `unclear` is a real answer a person can act on, and a loop that hit a
      // cap is not it. The reason rides beside it.
      classification: args.classification.classification,
      classificationReasoning: args.classification.reasoning,
      notClassifiedReason: args.classification.notClassifiedReason,
      shipmentCount: args.candidate.shipments,
      latestShipmentDate: args.candidate.latestShipmentDate,
      topHsCodes: args.query.hsCodes as never,
      arrivalCountries: args.query.arrivalCountries as never,
      // Verified where THIS Program's ownership graph puts it in an accepted
      // Supplier's family; otherwise a LABELLED, never hidden, name-token
      // guess — which now names the Supplier it guessed at.
      relatedSupplierId: args.relation.relatedSupplierId,
      relationVerified: args.relation.relationVerified,
      jobId: args.jobId ?? null,
    })
    .onConflictDoNothing();
}

/**
 * Family members of **this Program's** accepted Profiles, mapped to the
 * Supplier each one hangs off (SPEC §11.2).
 *
 * The map was built from `select().from(family_member)` with no `WHERE` at
 * all, so a Lead could be marked *related by ownership · verified* off another
 * Program's ownership graph — and the row it was verified against named no
 * Supplier, because only the root entity id was kept. Joining through `match`
 * and `supplier` is what makes the badge a statement about this roster, and
 * carrying the Supplier id is what lets it say whose family the Lead is in.
 *
 * Ordered, and first-wins: two Suppliers can legitimately share a Family
 * member (the seed holds two shared-parent pairs), and which one the badge
 * names must not be decided by Postgres row order. Roster order is the order
 * a person reads the shortlist in.
 */
export async function loadFamilyOwners(
  db: Database,
  programId: string,
): Promise<Map<string, string>> {
  const rows = await db
    .select({
      member: t.familyMember.memberEntityId,
      supplierId: t.supplier.id,
    })
    .from(t.familyMember)
    .innerJoin(t.match, eq(t.match.entityId, t.familyMember.rootEntityId))
    .innerJoin(t.supplier, eq(t.supplier.id, t.match.supplierId))
    .where(and(eq(t.supplier.programId, programId), eq(t.match.status, 'accepted')))
    .orderBy(asc(t.supplier.rosterIndex), asc(t.familyMember.memberEntityId));

  const owners = new Map<string, string>();
  for (const row of rows) {
    if (!owners.has(row.member)) owners.set(row.member, row.supplierId);
  }
  return owners;
}

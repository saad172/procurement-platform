import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as t from '@/db/schema';
import {
  DISCOVER_CLASSIFY_TOP_N,
  DISCOVER_TRADE_LIMIT,
  DISCOVER_TRADE_PAGE_CAP,
  JOB_CAPS,
} from '@/config/constants';
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
import { attributeTexts, type SayariEntity, type SayariTradeRow } from '@/upstream/projections/sayari';
import { upsertEntity } from './resolve';
import { raiseIfStopped } from './stops';

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
  /**
   * The trade search envelope's own `size.count` — how many counterparties
   * the query matched in total, so the UI can say "n of m" rather than just
   * "n proposed" (ticket 01 item C). Null when the search returned no count.
   */
  tradeTotalCount: number | null;
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

  return {
    proposed: search.ranked.length,
    classified,
    alreadyOnRoster: search.alreadyOnRoster,
    tradeTotalCount: search.tradeTotalCount,
  };
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
  if (lines.length === 0) {
    return { result: { proposed: 0, classified: 0, alreadyOnRoster: 0, tradeTotalCount: null } };
  }

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
  ranked: {
    entity: SayariEntity;
    shipments: number | null;
    latestShipmentDate: string | null;
    /** This ROW's own `metadata.hs_codes`, never the Category's queried
     * lines — a Lead's HS footprint is the row's, not the query's (ticket 01
     * item C). Empty when the row states none; never backfilled from `query`. */
    hsCodes: string[];
  }[];
  alreadyOnRoster: number;
  /** Family member entity id → the Supplier of THIS Program whose family holds it. */
  familyOwners: Map<string, string>;
  roster: RosterSupplier[];
  /** The trade search envelope's own `size.count` (ticket 01 item C). */
  tradeTotalCount: number | null;
};

/**
 * Follows the trade search's own `next`/`offset` cursor for up to
 * `DISCOVER_TRADE_PAGE_CAP` pages, in the style of `paginateTraversal`
 * (`src/upstream/paginate.ts`): the same guard order — stop BEFORE spending a
 * call, not after — the same rule that the envelope's own echoed
 * `offset`/`limit` are read rather than the ones sent, and the same guard
 * against a cursor that does not advance.
 *
 * `tradeTotalCount` is read once, off the first page. It is the query's own
 * total (`size.count`), not a running tally the pages add up to, so every
 * later page would report the identical number.
 *
 * Deduped across pages by entity id — a row this build has already pooled
 * from an earlier page is not a second candidate, whatever page it turns up
 * on again.
 */
export async function fetchTradeRows(
  deps: Pick<DiscoverDeps, 'upstream'>,
  query: { hsCodes: string[]; arrivalCountries: string[] },
): Promise<{ rows: SayariTradeRow[]; tradeTotalCount: number | null }> {
  const seen = new Set<string>();
  const rows: SayariTradeRow[] = [];
  let tradeTotalCount: number | null = null;
  let offset = 0;

  for (let page = 0; page < DISCOVER_TRADE_PAGE_CAP; page += 1) {
    const trade = await deps.upstream.sayari.tradeSearchSuppliers({
      hsCodes: query.hsCodes,
      arrivalCountries: query.arrivalCountries,
      limit: DISCOVER_TRADE_LIMIT,
      // Absent on the first page, deliberately: `offset` carries no default
      // (`src/upstream/endpoints.ts`), so sending `0` explicitly would still
      // add a key to `params` that every page-one call before this ticket
      // never had, changing `params_hash` for all of them (SPEC §16.6).
      ...(offset > 0 ? { offset } : {}),
    });

    // The query's own total, read once — later pages would only repeat it.
    if (tradeTotalCount === null) tradeTotalCount = trade.data.size?.count ?? null;

    const pageRows = trade.data.data ?? [];
    for (const row of pageRows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
    }

    if (pageRows.length === 0 || !hasMoreTradeRows(trade.data)) break;

    const next = nextTradeOffset(trade.data, offset, DISCOVER_TRADE_LIMIT);
    // A cursor that does not advance is a loop, and a loop against a call
    // measured at 3.6-13.4 s (SPEC §11.1) is the expensive kind.
    if (next <= offset) break;
    offset = next;
  }

  return { rows, tradeTotalCount };
}

/** `next` is a boolean on the live API, like `traversal`'s own (`paginate.ts`). */
function hasMoreTradeRows(envelope: { next?: boolean | string | null | undefined }): boolean {
  const next = envelope.next;
  return typeof next === 'string' ? next.length > 0 : next === true;
}

/**
 * The server's own echoed `offset` and `limit`, preferred over the ones this
 * build sent — the request is a request and the envelope is the answer
 * (`paginate.ts`'s own `nextOffset`, mirrored here for the trade envelope's
 * shape rather than the traversal one).
 */
function nextTradeOffset(
  envelope: { offset?: number | null | undefined; limit?: number | null | undefined },
  offset: number,
  limit: number,
): number {
  const from = typeof envelope.offset === 'number' ? envelope.offset : offset;
  const step = typeof envelope.limit === 'number' && envelope.limit > 0 ? envelope.limit : limit;
  return from + step;
}

/** Runs the trade search, then ranks and dedupes it against the roster. */
async function searchTradeCandidates(
  deps: DiscoverDeps,
  args: { programId: string },
  query: DiscoverQuery,
): Promise<RankedCandidates> {
  const { db } = deps;
  const { hsCodes, arrivalCountries } = query;

  const { rows: tradeRows, tradeTotalCount } = await fetchTradeRows(deps, { hsCodes, arrivalCountries });

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

  const rows = tradeRows;
  let alreadyOnRoster = 0;
  const candidates: {
    entity: SayariEntity;
    shipments: number | null;
    latestShipmentDate: string | null;
    hsCodes: string[];
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
      hsCodes: hsCodesOf(row),
    });
  }

  const ranked = candidates
    .sort(
      (a, b) =>
        prefilterScore(b.entity.label) - prefilterScore(a.entity.label) ||
        (b.shipments ?? 0) - (a.shipments ?? 0),
    )
    .slice(0, DISCOVER_CLASSIFY_TOP_N);

  return { ranked, alreadyOnRoster, familyOwners, roster, tradeTotalCount };
}

/**
 * **A Lead's HS footprint is the row's** (ticket 01 item C, CONTEXT.md
 * *Discover*). `metadata.hs_codes` is an array of `{ key, value, doc_count }`
 * — `key` is the six-digit line this row actually shipped under, which can
 * differ from any single line of the Category's own queried lines the search
 * was run over. Deduped, and empty (never backfilled from the query) when the
 * row states none — a guess dressed as the row's own fact would be worse than
 * an honest blank.
 */
export function hsCodesOf(row: SayariTradeRow): string[] {
  const codes = row.metadata?.hs_codes ?? [];
  return [...new Set(codes.map((c) => c.key).filter((k): k is string => Boolean(k)))];
}

/** Classifies each ranked candidate and records it as a Lead. */
async function classifyAndRecordLeads(
  deps: DiscoverDeps,
  args: { programId: string; categoryId: string },
  query: DiscoverQuery,
  search: RankedCandidates,
): Promise<{ classified: number }> {
  const { db } = deps;
  const { ranked, familyOwners, roster, tradeTotalCount } = search;
  let classified = 0;

  for (const candidate of ranked) {
    await upsertEntity(db, candidate.entity);

    const result = await classifyCandidate(deps, query, candidate);
    const outcome = readLeadClassification(result);
    if (outcome.classification) classified += 1;

    await recordLead(db, {
      programId: args.programId,
      categoryId: args.categoryId,
      candidate,
      query,
      tradeTotalCount,
      classification: outcome,
      relation: decideLeadRelation(
        { entityId: candidate.entity.id, label: candidate.entity.label },
        { familyOwners, roster },
      ),
      jobId: deps.jobId,
    });

    /**
     * A ceiling reached part-way through 25 classifications stops the Job
     * rather than quietly filing the rest as `unclear`, which is a verdict.
     *
     * **Raised after the row is written, not before it.**
     * `readLeadClassification` salvages a submission a ceiling fired one turn
     * too late to stop, and writes the cap's own sentence when there is
     * nothing to salvage. Raising first would throw both away along with the
     * candidate they were about, and leave the Lead unwritten rather than
     * unclassified-for-a-stated-reason.
     */
    raiseIfStopped(result);
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
            // This ROW's own HS lines, not the Category's queried ones — a
            // Lead's HS footprint is the row's (ticket 01 item C).
            topHsCodes: candidate.hsCodes,
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
    /** The trade search envelope's own `size.count` (ticket 01 item C). */
    tradeTotalCount: number | null;
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
      // This ROW's own HS lines, never the Category's queried ones (ticket 01
      // item C) — a Lead's HS footprint is the row's, not the query's.
      topHsCodes: args.candidate.hsCodes as never,
      arrivalCountries: args.query.arrivalCountries as never,
      tradeTotalCount: args.tradeTotalCount,
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

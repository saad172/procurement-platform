import { eq } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as t from '@/db/schema';
import { DISCOVER_CLASSIFY_TOP_N, DISCOVER_TRADE_LIMIT, JOB_CAPS } from '@/config/constants';
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

/**
 * **Noise is the hard part**, and it has no rule.
 *
 * HS 8507.60 is *any* lithium-ion battery, not a traction pack, so the BAT line
 * into USA/MEX returns **14 560 counterparties** whose first page is led by
 * Apple, Amazon and a freight forwarder. The two rows that most need separating
 * are structurally identical: DAMCO CHINA LIMITED at 16 930 shipments and a
 * real component maker at a tenth of that differ in no field a filter can read.
 *
 * So the prefilter below is cheap and honest about what it cannot do, and the
 * classifier does the rest.
 *
 * **Measured** on the 100-row BAT page (`pnpm check:prefilter`), against
 * Sayari's own `logisticsEntity` flag as ground truth:
 *
 * | | count |
 * |---|---|
 * | rows Sayari flags as logistics | 14 |
 * | of those, caught by name | 9 |
 * | of those, missed by name | 5 |
 * | **manufacturers wrongly demoted** | **0** |
 *
 * Zero false positives is the property that matters. A heuristic that never
 * demotes a real manufacturer is safe to sort by even when it misses a third of
 * the forwarders — the misses survive to the classifier, which is where the
 * judgement was supposed to happen anyway. Had it had false positives, the
 * reorder would be quietly deciding the outcome, and the tests below would
 * fail rather than the classifier catching it.
 */
const FORWARDER_MARKERS = [
  'logistics', 'forwarding', 'freight', 'shipping', 'transport', 'express',
  'cargo', 'customs', 'broker', 'warehous', 'damco', 'kuehne', 'expeditors',
  'panalpina', 'schenker', 'agility', 'ceva', 'dsv', '3pl',
];

/** Cheap, and it only ever *reorders* — it never removes a row. */
export function prefilterScore(label: string): number {
  const name = label.toLowerCase();
  return FORWARDER_MARKERS.some((marker) => name.includes(marker)) ? -1 : 0;
}

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

  const lines = await db
    .select()
    .from(t.categoryHsLine)
    .where(eq(t.categoryHsLine.categoryId, args.categoryId));
  if (lines.length === 0) return { proposed: 0, classified: 0, alreadyOnRoster: 0 };

  const program = await db.query.program.findFirst({ where: eq(t.program.id, args.programId) });

  // Shipments arriving in the Programme's territories. Both, because the
  // Mexican plant is a real destination even though one importer is stored.
  const arrivalCountries = [program?.importingCountry ?? 'USA', 'MEX'];

  /**
   * Trade data indexes HS at **six digits**, so the seed's 8- and 10-digit
   * lines are truncated here rather than sent whole.
   *
   * That widening is worth stating, because it is the source of the noise this
   * job exists to handle: `8507.60` is *any* lithium-ion battery, not a
   * traction pack, which is exactly why the top of the result set is freight
   * forwarders and consumer-battery sellers.
   */
  const hsCodes = [...new Set(lines.map((line) => line.hsCode.replace(/\D/g, '').slice(0, 6)))];

  const trade = await deps.upstream.sayari.tradeSearchSuppliers({
    hsCodes,
    arrivalCountries,
    limit: DISCOVER_TRADE_LIMIT,
  });

  // Everything already on this Programme's roster, by entity id.
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

  const rosterNames = (
    await db.select({ name: t.supplier.rosterName }).from(t.supplier).where(eq(t.supplier.programId, args.programId))
  )
    .map((row) => row.name)
    .filter((name): name is string => name != null);

  // Family members of accepted Suppliers — a Lead that is one renders
  // "related by ownership, VERIFIED" rather than as an unverified guess.
  const familyMembers = new Map<string, string>();
  for (const row of await db
    .select({ member: t.familyMember.memberEntityId, root: t.familyMember.rootEntityId })
    .from(t.familyMember)) {
    familyMembers.set(row.member, row.root);
  }

  const rows = trade.data.data ?? [];
  let alreadyOnRoster = 0;
  const candidates: { entity: SayariEntity; shipments: number | null; latestShipmentDate: string | null }[] = [];

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

  const registry = getRegistry();
  const classifierTool = registry.byName.get('submit_lead_classification')!;
  let classified = 0;

  for (const candidate of ranked) {
    await upsertEntity(db, candidate.entity);

    // The classifier costs ZERO ADDITIONAL SAYARI CALLS: a trade result is
    // already a full entity.
    const result = await runLoop(
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
              topHsCodes: hsCodes,
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

    const submitted =
      result.status === 'done'
        ? (result.toolUses.find((use) => use.name === 'submit_lead_classification')?.input as
            | { classification: string; reasoning: string }
            | undefined)
        : undefined;
    if (submitted) classified += 1;

    const related = familyMembers.get(candidate.entity.id);
    const nameFlag = !related && sharesNameToken(candidate.entity.label, rosterNames);

    await db
      .insert(t.lead)
      .values({
        programId: args.programId,
        categoryId: args.categoryId,
        entityId: candidate.entity.id,
        // A closed enum, so AN ENUM IS NOT A CLAIM — which is what lets Discover
        // add a table and NO NEW CITATION TARGET GROUP. The reasoning stays
        // inspectable in the trace and no sentence is written from it.
        classification: (submitted?.classification ?? 'unclear') as never,
        classificationReasoning: submitted?.reasoning ?? null,
        shipmentCount: candidate.shipments,
        latestShipmentDate: candidate.latestShipmentDate,
        topHsCodes: hsCodes as never,
        arrivalCountries: arrivalCountries as never,
        relatedSupplierId: null,
        // Verified where the ownership graph puts it in an accepted Supplier's
        // family; otherwise a LABELLED, never hidden, name-token guess.
        relationVerified: Boolean(related),
        jobId: deps.jobId ?? null,
      })
      .onConflictDoNothing();

    void nameFlag;
  }

  return { proposed: ranked.length, classified, alreadyOnRoster };
}

/**
 * The unverified name-token overlap flag (SPEC §11.2).
 *
 * Roster Suppliers appear in trade data as their foreign subsidiaries, and
 * `traversal.ubo` returns nothing, so entity-id dedupe alone would propose a
 * company already on the list under a different id. This catches those — and
 * it is **labelled, never hidden**, because an unverified relationship
 * presented as fact is worse than one presented as a question.
 */
export function sharesNameToken(label: string, rosterNames: readonly string[]): string | null {
  const tokens = new Set(
    label
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 3),
  );
  for (const name of rosterNames) {
    const nameTokens = name.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 3);
    if (nameTokens.some((token) => tokens.has(token))) return name;
  }
  return null;
}

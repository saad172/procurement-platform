import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as t from '@/db/schema';
import { getRegistry, type ToolContext } from '@/tools';
import { getTestDb, testDatabaseIsUp } from '../support/test-db';
import { resetDerived } from '../support/reset';
import { seededProgram } from '../support/seeded-program';

/**
 * `get_shortlist`'s Concentration field (network spec §7, ticket 04 unit
 * 04d) — proves the pass-through both halves of the payload rely on:
 *
 * - the **model-facing** `data.ranked[].concentration` allowlist addition
 *   (names only, `src/tools/catalog/reads.ts` — this unit's own call, made
 *   because it is small and consistent with the rest of that allowlist), and
 * - the **widget-facing** payload, which gets `concentrationWith` for free
 *   by spreading `...shortlist` (`ShortlistEntry`, `src/db/queries/shortlist.ts`)
 *   with no changes needed at the tool layer.
 *
 * Seeded directly, the same pattern `tests/db/queries/shortlist-concentration.test.ts`
 * uses for the query itself — this file is the one proving the TOOL result
 * carries it, not the derivation.
 */
describe('get_shortlist — Concentration', () => {
  const ROSTER_A = 'Get Shortlist Concentration Supplier A';
  const ROSTER_B = 'Get Shortlist Concentration Supplier B';
  const ENTITY_A = 'test-get-shortlist-concentration-entity-a';
  const ENTITY_B = 'test-get-shortlist-concentration-entity-b';
  const SHARED_PARENT = 'test-get-shortlist-concentration-shared-parent';

  it('names the joined Supplier in the model summary and carries the shared terminal in the widget payload', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);
    const program = await seededProgram(db);
    const category = await db.query.category.findFirst({ where: eq(t.category.code, 'HAR') });
    if (!category) return;

    await db
      .delete(t.supplier)
      .where(and(eq(t.supplier.rosterName, ROSTER_A), eq(t.supplier.programId, program.id)));
    await db
      .delete(t.supplier)
      .where(and(eq(t.supplier.rosterName, ROSTER_B), eq(t.supplier.programId, program.id)));

    await db.insert(t.entity).values([
      { id: ENTITY_A, label: 'Get Shortlist Concentration Entity A', country: 'DEU' },
      { id: ENTITY_B, label: 'Get Shortlist Concentration Entity B', country: 'FRA' },
      { id: SHARED_PARENT, label: 'Get Shortlist Concentration Shared Parent', country: 'DEU' },
    ]);

    const [supplierA, supplierB] = await db
      .insert(t.supplier)
      .values([
        { programId: program.id, origin: 'imported', rosterIndex: 9201, rosterName: ROSTER_A },
        { programId: program.id, origin: 'imported', rosterIndex: 9202, rosterName: ROSTER_B },
      ])
      .returning({ id: t.supplier.id });

    await db.insert(t.supplierCategory).values([
      { supplierId: supplierA!.id, categoryId: category.id },
      { supplierId: supplierB!.id, categoryId: category.id },
    ]);
    await db.insert(t.match).values([
      { supplierId: supplierA!.id, status: 'accepted', entityId: ENTITY_A, settledBy: 'rules' },
      { supplierId: supplierB!.id, status: 'accepted', entityId: ENTITY_B, settledBy: 'rules' },
    ]);
    await db.insert(t.criterionValue).values([
      {
        supplierId: supplierA!.id,
        programId: program.id,
        categoryId: null,
        criterionKey: 'compliance_risk',
        value: 80,
        rawInputs: {},
        anchorLine: 'test anchor',
      },
      {
        supplierId: supplierB!.id,
        programId: program.id,
        categoryId: null,
        criterionKey: 'compliance_risk',
        value: 80,
        rawInputs: {},
        anchorLine: 'test anchor',
      },
    ]);

    const [upstreamResponse] = await db
      .insert(t.upstreamResponse)
      .values({
        source: 'sayari',
        endpoint: 'traversal.ownership',
        paramsHash: 'test-hash-get-shortlist-concentration',
        params: {},
        body: {},
        bodyHash: 'test-body-hash-get-shortlist-concentration',
        via: 'sdk',
      })
      .returning({ id: t.upstreamResponse.id });
    const [enrichment] = await db
      .insert(t.enrichment)
      .values({
        source: 'sayari_ownership_family',
        subjectKind: 'entity',
        subjectKey: ENTITY_A,
        requestParams: {},
        upstreamResponseId: upstreamResponse!.id,
      })
      .returning({ id: t.enrichment.id });
    await db.insert(t.graphPath).values([
      {
        rootEntityId: ENTITY_A,
        terminalEntityId: SHARED_PARENT,
        kind: 'family',
        direction: 'down',
        hopDepth: 1,
        enrichmentId: enrichment!.id,
      },
      {
        rootEntityId: ENTITY_B,
        terminalEntityId: SHARED_PARENT,
        kind: 'family',
        direction: 'down',
        hopDepth: 1,
        enrichmentId: enrichment!.id,
      },
    ]);

    const ctx: ToolContext = {
      db,
      upstream: undefined as never,
      meter: { addModelTokens: () => {} },
      runId: 'test-run-get-shortlist-concentration',
      surface: 'chat',
    };
    const result = await getRegistry()
      .byName.get('get_shortlist')!
      .handler({ programId: program.id, categoryId: category.id }, ctx);
    if (!result.ok) throw new Error(result.objections.join('; '));

    const data = (
      result.data as {
        data: { ranked: { supplierId: string; concentration: string[] }[] };
      }
    ).data;
    const rowA = data.ranked.find((r) => r.supplierId === supplierA!.id);
    expect(rowA?.concentration).toEqual([ROSTER_B]);
    // No leak of the shared entity into the model-facing summary.
    expect(rowA).not.toHaveProperty('terminalEntityId');
    expect(rowA).not.toHaveProperty('concentrationWith');

    const widget = (
      result.data as {
        widget: {
          payload: {
            ranked: {
              supplierId: string;
              concentrationWith: { supplierId: string; terminalLabel: string }[];
            }[];
          };
        };
      }
    ).widget;
    const widgetRowA = widget.payload.ranked.find((r) => r.supplierId === supplierA!.id);
    expect(widgetRowA?.concentrationWith).toEqual([
      {
        supplierId: supplierB!.id,
        displayName: ROSTER_B,
        terminalEntityId: SHARED_PARENT,
        terminalLabel: 'Get Shortlist Concentration Shared Parent',
      },
    ]);
  });
});

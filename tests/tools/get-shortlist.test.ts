import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as t from '@/db/schema';
import { getRegistry } from '@/tools';
import type { ToolContext } from '@/tools';
import { replayUpstream } from '@/fixtures/replay-upstream';
import { getTestDb, testDatabaseIsUp } from '../support/test-db';
import { resetDerived } from '../support/reset';
import { buildAssessableSupplier, openJob } from '../support/pipeline';

/**
 * `get_shortlist` returns a Shortlist.
 *
 * ## Why this test exists
 *
 * It shipped as a stub. The handler ran the bidder query, **discarded the
 * rows**, and returned `{ programId, categoryId, weights, bidderCount }` behind
 * a description promising *"the suppliers of one programme and category, ranked
 * by score, with the weight vector that produced the ranking and the excluded
 * block beneath it"*. A comment said the assembly would land with the pages in
 * build-order step 11. Step 11 landed; the tool was never pointed at
 * `loadShortlist()`.
 *
 * Nothing caught it, because **no test asserted the payload of a read** — the
 * replay fixtures assert what a *model* did with a tool result, which passes
 * happily when the result is thin. The cost was paid twice: chat could not name
 * a supplier, and `recommend`'s lead agent had no tool that returned a Score or
 * a rank at all.
 *
 * So the assertions here are about the **shape of what a read hands back**,
 * which is the class of bug that got through.
 *
 * Offline: the pipeline replays resolve and enrich from recorded fixtures and
 * cached upstream bodies. No credentials, no credits.
 */
describe('get_shortlist', () => {
  it('returns ranked suppliers rather than a count of them', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();

    await resetDerived(db);
    const { supplierId, programId, runId } = await buildAssessableSupplier(db, 'Yazaki');

    const category = await db.query.category.findFirst({ where: eq(t.category.code, 'HAR') });
    if (!category) return;

    const result = await callGetShortlist(db, runId, {
      programId,
      categoryId: category.id,
    });
    if (!result.ok) throw new Error(result.objections.join('; '));
    const { data, widget } = result.data;

    // ── The regression itself ───────────────────────────────────────────────
    expect(data).not.toHaveProperty('bidderCount');
    expect(data.ranked.length).toBeGreaterThan(0);

    // The resolved Supplier is IN the ranking, by name, with a Score — the two
    // facts the old payload could not carry and the model therefore could not
    // say.
    const yazaki = data.ranked.find((row) => row.supplierId === supplierId);
    expect(yazaki?.name).toBeTruthy();
    expect(typeof yazaki?.score).toBe('number');
    expect(yazaki?.rank).toBe(1);

    // ── Excluded is never ranked low (SPEC §13.3) ───────────────────────────
    // Its rows carry a reason and no Score, and they are a separate block
    // rather than the bottom of the ranking.
    for (const row of data.excluded) {
      expect(['no_match', 'no_category']).toContain(row.reason);
      expect(data.ranked.map((r) => r.supplierId)).not.toContain(row.supplierId);
    }

    // ── The split (SPEC §14.4) ──────────────────────────────────────────────
    // What the model reads is not what the widget renders. The model gets
    // enough to name a winner; the criteria arrays stay with the widget, so
    // eight categories of contributions are not billed on every turn.
    expect(data.ranked[0]).not.toHaveProperty('criteria');
    const payload = widget.payload as { ranked: { criteria: unknown[] }[] };
    expect(payload.ranked[0]!.criteria.length).toBeGreaterThan(0);
    expect(widget.type).toBe('shortlist_table');
  });

  /**
   * The what-if trap.
   *
   * §14.3 *instructs* the model to answer about the ranking on screen. An
   * instruction can be forgotten, and a turn that omitted `weights` used to
   * answer about the Programme default while a what-if was live — in the one
   * surface with no Citation check. The vector now defaults from the view
   * state, so forgetting is not a thing the model can do.
   */
  it('defaults its weight vector from the rail the person is looking at', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();

    await resetDerived(db);
    const { programId, runId } = await buildAssessableSupplier(db, 'Yazaki');
    const category = await db.query.category.findFirst({ where: eq(t.category.code, 'HAR') });
    if (!category) return;

    const onDefault = await callGetShortlist(db, runId, { programId, categoryId: category.id });
    if (!onDefault.ok) throw new Error(onDefault.objections.join('; '));
    expect(onDefault.data.data.weights).toBe('programme default');

    // The same call, from a page whose rail has been dragged.
    const onWhatIf = await callGetShortlist(
      db,
      runId,
      { programId, categoryId: category.id },
      { 'w.compliance_risk': '40' },
    );
    if (!onWhatIf.ok) throw new Error(onWhatIf.objections.join('; '));

    // It is no longer reported as the Programme's own ranking, and the vector
    // it names is the one from the URL.
    expect(onWhatIf.data.data.weights).not.toBe('programme default');
    const weights = onWhatIf.data.data.weights as Record<string, number>;
    expect(weights.compliance_risk).toBeGreaterThan(
      (onDefault.data.widget.payload as { weights: Record<string, number> }).weights
        .compliance_risk ?? 0,
    );
  });

  /** An explicit what-if the model asked for still wins over the rail. */
  it('lets an explicit vector override the view state', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();

    await resetDerived(db);
    const { programId, runId } = await buildAssessableSupplier(db, 'Yazaki');
    const category = await db.query.category.findFirst({ where: eq(t.category.code, 'HAR') });
    if (!category) return;

    const result = await callGetShortlist(
      db,
      runId,
      { programId, categoryId: category.id, weights: { compliance_risk: 90 } },
      { 'w.compliance_risk': '10' },
    );
    if (!result.ok) throw new Error(result.objections.join('; '));

    const weights = (result.data.widget.payload as { weights: Record<string, number> }).weights;
    // Renormalised, so not 90 — but decisively the model's vector, not the URL's.
    expect(weights.compliance_risk).toBeGreaterThan(50);
  });
});

type ShortlistModelData = {
  category: string;
  weights: unknown;
  ranked: { rank: number | null; supplierId: string; name: string; score: number | null }[];
  excluded: { supplierId: string; name: string; reason: string }[];
  visibleCount: number;
  totalCount: number;
};

async function callGetShortlist(
  db: Awaited<ReturnType<typeof getTestDb>>,
  runId: string,
  input: { programId: string; categoryId: string; weights?: Record<string, number> },
  viewState?: Record<string, string>,
) {
  const jobId = await openJob(db, runId, 'recommend', input.categoryId);
  const ctx: ToolContext = {
    db,
    upstream: replayUpstream(db, runId, jobId),
    meter: { addModelTokens: () => {} },
    runId,
    jobId,
    surface: 'chat',
    viewState,
  };
  const tool = getRegistry().byName.get('get_shortlist')!;
  return (await tool.handler(input, ctx)) as
    | { ok: true; data: { data: ShortlistModelData; widget: { type: string; payload: unknown } } }
    | { ok: false; objections: string[] };
}

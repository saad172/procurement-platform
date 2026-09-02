import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as t from '@/db/schema';
import { getRegistry, type ToolContext } from '@/tools';
import { resolveCitations, citationKey } from '@/jobs/publish';
import { replayUpstream } from '@/fixtures/replay-upstream';
import { getTestDb, testDatabaseIsUp } from '../support/test-db';
import { resetDerived } from '../support/reset';
import { buildAssessableSupplier, openJob } from '../support/pipeline';

/**
 * **A payload must carry the ids its own claims can be cited through**
 * (findings 73, 103 and 106).
 *
 * A Citation resolves to a live local row or the sentence cannot be inserted,
 * and the model may only cite what a tool showed it. So for every citation
 * target group, some tool has to hand over the id — and the two that did not
 * cost a full pipeline run each: a Shortlist citation is the pair
 * `{programId, categoryId}`, and no tool returned a `programId` at all, so the
 * one attempt at citing a ranking spelled the Program as a slug.
 *
 * These assertions are about the **ids in a payload**, which is the class of
 * bug that got through: a replay fixture asserts what a model did with a tool
 * result, and passes happily when the result is one id short.
 */
describe('the ids a sentence can cite', () => {
  it('get_assessment_brief carries the pair a shortlist citation is made of', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);
    const { supplierId, programId, runId } = await buildAssessableSupplier(db, 'Yazaki');

    const brief = (await call(db, runId, 'get_assessment_brief', {
      supplierId,
      programId,
    })) as { programId: string | null; categoryIds: string[]; matchId: string | null };

    expect(brief.programId).toBe(programId);
    expect(brief.categoryIds.length).toBeGreaterThan(0);

    // Both halves resolve, which is what "an Assessment can cite a Shortlist"
    // means: the citation reaches a live local row before anything is inserted.
    const citation = {
      shortlist: { programId: brief.programId!, categoryId: brief.categoryIds[0]! },
    };
    const rows = await resolveCitations(db, [citation as never]);
    expect(rows.get(citationKey(citation as never))).toBeDefined();
  });

  it('get_recommendation_brief carries them for every bidder', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    const supplier = await db.query.supplier.findFirst({
      where: eq(t.supplier.rosterName, 'Yazaki'),
    });
    const [run] = await db.select().from(t.run).limit(1);
    if (!supplier || !run) return;
    const category = await db.query.category.findFirst({ where: eq(t.category.code, 'HAR') });
    if (!category) return;

    const brief = (await call(db, run.id, 'get_recommendation_brief', {
      supplierId: supplier.id,
      programId: supplier.programId,
      categoryId: category.id,
    })) as { suppliers: { programId: string | null; categoryIds: string[] }[] };

    expect(brief.suppliers.length).toBeGreaterThan(0);
    for (const row of brief.suppliers) {
      expect(row.programId).toBe(supplier.programId);
      expect(row.categoryIds).toContain(category.id);
    }
  });

  it('get_supplier_family carries the enrichment id its counts belong to', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    const supplier = await db.query.supplier.findFirst({
      where: eq(t.supplier.rosterName, 'Yazaki'),
    });
    const [run] = await db.select().from(t.run).limit(1);
    if (!supplier || !run) return;

    const family = (await call(db, run.id, 'get_supplier_family', {
      supplierId: supplier.id,
    })) as {
      enrichmentId: string | null;
      explored: number;
      truncated: boolean;
      members: { entityId: string; enrichmentId: string }[];
    };

    // The number and the id it can be cited through arrive together, which is
    // the whole of finding 106.
    expect(family.explored).toBeGreaterThan(0);
    expect(family.enrichmentId).toBeTruthy();
    for (const member of family.members) expect(member.enrichmentId).toBeTruthy();

    const citation = { enrichmentId: family.enrichmentId! };
    const rows = await resolveCitations(db, [citation as never]);
    expect(rows.get(citationKey(citation as never))?.explored).toBe(family.explored);
  });
});

async function call(
  db: Awaited<ReturnType<typeof getTestDb>>,
  runId: string,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const jobId = await openJob(db, runId, 'assess', String(input.supplierId));
  const ctx: ToolContext = {
    db,
    upstream: replayUpstream(db, runId, jobId),
    meter: { addModelTokens: () => {} },
    runId,
    jobId,
    surface: 'job',
  };
  const result = await getRegistry().byName.get(name)!.handler(input, ctx);
  if (!result.ok) throw new Error(result.objections.join('; '));
  // Every chat-reachable read wraps its payload as `{ data, widget }`; the
  // job-only briefs do not. The model reads the data half either way.
  const data = result.data as { data?: unknown; widget?: unknown };
  return data.widget ? data.data : data;
}

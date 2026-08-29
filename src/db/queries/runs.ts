import { desc, eq, inArray } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as t from '@/db/schema';
import { MODEL_PRICE_USD_PER_MTOK } from '@/config/constants';

/**
 * The Runs branch's queries (SPEC §18.5, §18.6).
 *
 * Every dollar figure here is computed from a **committed price constant, not a
 * bill**, and the page says so — which is the honest form of a number nobody
 * can reconcile against an invoice.
 */

export type RunSummary = {
  run: typeof t.run.$inferSelect;
  jobCount: number;
  terminatedCount: number;
  failedCount: number;
  actualUsd: number;
  sayariCalls: number;
  durationMs: number | null;
};

export async function loadRuns(db: Database, programId: string): Promise<RunSummary[]> {
  const runs = await db
    .select()
    .from(t.run)
    .where(eq(t.run.programId, programId))
    .orderBy(desc(t.run.createdAt));
  if (runs.length === 0) return [];

  const runIds = runs.map((r) => r.id);
  const jobs = await db.select().from(t.job).where(inArray(t.job.runId, runIds));
  const usage = await db.select().from(t.usageEvent).where(inArray(t.usageEvent.runId, runIds));

  return runs.map((run) => {
    const runJobs = jobs.filter((j) => j.runId === run.id);
    const runUsage = usage.filter((u) => u.runId === run.id);
    return {
      run,
      jobCount: runJobs.length,
      // A TERMINATED job does not fail its run — the run continues and reports
      // "2 jobs stopped at their ceiling".
      terminatedCount: runJobs.filter((j) => j.state === 'terminated').length,
      failedCount: runJobs.filter((j) => j.state === 'failed').length,
      actualUsd: priceOf(runUsage),
      // Sayari's own counters are account-scoped and lag; this is OUR count of
      // outbound attempts, which is a different number and is labelled as one.
      sayariCalls: runUsage.filter((u) => u.source === 'sayari' && !u.cacheHit).length,
      durationMs:
        run.startedAt && run.finishedAt ? run.finishedAt.getTime() - run.startedAt.getTime() : null,
    };
  });
}

function priceOf(usage: (typeof t.usageEvent.$inferSelect)[]): number {
  return usage.reduce((sum, row) => {
    if (!row.model) return sum;
    const price = MODEL_PRICE_USD_PER_MTOK[row.model] ?? MODEL_PRICE_USD_PER_MTOK['claude-opus-5']!;
    const input = (row.inputTokens ?? 0) + (row.cacheCreationInputTokens ?? 0) + (row.cacheReadInputTokens ?? 0);
    return sum + (input / 1e6) * price.input + ((row.outputTokens ?? 0) / 1e6) * price.output;
  }, 0);
}

/**
 * The two derived numbers that **earn a place on the Run page** (SPEC §18.5),
 * neither of which needs new storage.
 */
export type RunInsights = {
  /** "31 of 50 settled by rules — 0 tokens": the cheapest honest efficiency number. */
  settledByRules: { rules: number; total: number };
  /**
   * "Rounds: 62 · 14 spent on code rejections" — which makes Round consumption
   * a **quality** number, not only a cost one.
   */
  rounds: { total: number; codeRejections: number };
};

export async function loadRunInsights(db: Database, programId: string): Promise<RunInsights> {
  const matches = await db
    .select({ settledBy: t.match.settledBy })
    .from(t.match)
    .innerJoin(t.supplier, eq(t.supplier.id, t.match.supplierId))
    .where(eq(t.supplier.programId, programId));

  const rounds = await db.select({ role: t.round.role, source: t.round.source }).from(t.round);

  return {
    settledByRules: {
      rules: matches.filter((m) => m.settledBy === 'rules').length,
      total: matches.length,
    },
    rounds: {
      total: rounds.length,
      codeRejections: rounds.filter((r) => r.role === 'evaluator' && r.source === 'code').length,
    },
  };
}

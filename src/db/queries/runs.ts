import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
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

/**
 * Whether a worker has picked anything up recently.
 *
 * A **liveness** question, not a health one: a Job queued with no worker
 * running sits in `queued` for ever, and the Run panel would otherwise look as
 * though it had done something. Recent activity is the only signal available —
 * the worker holds no inbound port, by design (SPEC §2.2).
 *
 * The clock is read **here** and not in the component. React's purity rule
 * rejects `Date.now()` during render, and it is right beyond the letter:
 * a page that re-rendered would answer differently for the same rows. One read
 * per request (finding 29).
 */
export async function loadWorkerHealth(
  db: Database,
): Promise<{ workerUp: boolean; nowMs: number }> {
  return { workerUp: await workerSeemsUp(db), nowMs: Date.now() };
}

export async function workerSeemsUp(db: Database, withinMs = 5 * 60 * 1000): Promise<boolean> {
  const [recent] = await db
    .select({ startedAt: t.job.startedAt })
    .from(t.job)
    .where(isNotNull(t.job.startedAt))
    .orderBy(desc(t.job.startedAt))
    .limit(1);

  return recent?.startedAt != null && Date.now() - recent.startedAt.getTime() < withinMs;
}

/**
 * Where a Run has got to (SPEC §18.4).
 *
 * A pure function over Jobs the page has already loaded, because the Run page
 * needs every Job row anyway and a second round trip would only be a chance for
 * the header and the table to disagree.
 */
export type RunProgress = {
  total: number;
  queued: number;
  running: number;
  done: number;
  failed: number;
  terminated: number;
  pausedOnBudget: number;
  cancelled: number;
  /** Reached an end, whichever end. The numerator of "6 of 10". */
  settled: number;
  /**
   * Whether anything is still moving — the one condition the page polls on.
   * `paused_on_budget` is deliberately **not** active: it waits on a person,
   * not on a worker, and re-reading would never change it.
   */
  active: boolean;
};

export function runProgress(jobs: { state: typeof t.job.$inferSelect.state }[]): RunProgress {
  const count = (state: typeof t.job.$inferSelect.state) =>
    jobs.filter((job) => job.state === state).length;

  const queued = count('queued');
  const running = count('running');
  const progress = {
    total: jobs.length,
    queued,
    running,
    done: count('done'),
    failed: count('failed'),
    terminated: count('terminated'),
    pausedOnBudget: count('paused_on_budget'),
    cancelled: count('cancelled'),
    active: queued + running > 0,
  };
  return { ...progress, settled: progress.total - queued - running };
}

/**
 * What each Job has actually done so far, **derived rather than stored**.
 *
 * `job.tool_calls_used` and `job.tokens_used` are written by nothing: the run
 * loop counts both in local variables to enforce the ceilings (SPEC §18.3) and
 * the handler contract carries no counters back, so those two columns render 0
 * for every Job that ever ran. Reading `trace_tool_call` and `usage_event`
 * instead fixes the number *and* makes it live — the rows land turn by turn
 * while the Job is still running, which a write-back at the end never could.
 *
 * One home for usage stays one home: this counts the rows, it does not add a
 * second place they are written.
 */
export type JobActivity = {
  turns: number;
  toolCalls: number;
  /**
   * Billed outbound attempts. **The number the per-Job ceiling actually
   * bounds**, and for a deterministic Job it is the only one there is: `enrich`
   * runs no model, so its Trace has no turns and no tool calls, and the column
   * read `0 / 25` however many sources it had fetched.
   */
  upstreamCalls: number;
  tokens: number;
  /** The tool names of the most recent turn — the legible "what it is doing". */
  lastTools: string[];
};

export async function loadJobActivity(
  db: Database,
  jobIds: string[],
): Promise<Map<string, JobActivity>> {
  const activity = new Map<string, JobActivity>();
  if (jobIds.length === 0) return activity;

  const turns = await db
    .select({ id: t.traceTurn.id, jobId: t.traceTurn.jobId, n: t.traceTurn.n })
    .from(t.traceTurn)
    .where(inArray(t.traceTurn.jobId, jobIds));

  const calls =
    turns.length === 0
      ? []
      : await db
          .select({ turnId: t.traceToolCall.traceTurnId, toolName: t.traceToolCall.toolName })
          .from(t.traceToolCall)
          .where(
            inArray(
              t.traceToolCall.traceTurnId,
              turns.map((turn) => turn.id),
            ),
          );

  const usage = await db
    .select({
      jobId: t.usageEvent.jobId,
      model: t.usageEvent.model,
      cacheHit: t.usageEvent.cacheHit,
      inputTokens: t.usageEvent.inputTokens,
      outputTokens: t.usageEvent.outputTokens,
      cacheCreationInputTokens: t.usageEvent.cacheCreationInputTokens,
      cacheReadInputTokens: t.usageEvent.cacheReadInputTokens,
    })
    .from(t.usageEvent)
    .where(inArray(t.usageEvent.jobId, jobIds));

  const callsByTurn = new Map<string, string[]>();
  for (const call of calls) {
    callsByTurn.set(call.turnId, [...(callsByTurn.get(call.turnId) ?? []), call.toolName]);
  }

  for (const jobId of jobIds) {
    const jobTurns = turns.filter((turn) => turn.jobId === jobId);
    // The highest `n` that actually called something: the last turn is often a
    // final answer with no tool use, and naming nothing is less useful than
    // naming the last thing it reached for.
    const latest = jobTurns
      .filter((turn) => (callsByTurn.get(turn.id)?.length ?? 0) > 0)
      .sort((a, b) => b.n - a.n)[0];

    activity.set(jobId, {
      turns: jobTurns.length,
      toolCalls: jobTurns.reduce((sum, turn) => sum + (callsByTurn.get(turn.id)?.length ?? 0), 0),
      // Billed only: a cache hit spends no credit, and the ceiling bounds spend.
      upstreamCalls: usage.filter((row) => row.jobId === jobId && !row.model && !row.cacheHit).length,
      tokens: usage
        .filter((row) => row.jobId === jobId)
        .reduce(
          (sum, row) =>
            sum +
            (row.inputTokens ?? 0) +
            (row.outputTokens ?? 0) +
            (row.cacheCreationInputTokens ?? 0) +
            (row.cacheReadInputTokens ?? 0),
          0,
        ),
      lastTools: latest ? (callsByTurn.get(latest.id) ?? []) : [],
    });
  }

  return activity;
}

/**
 * Whether this Program has a Run still moving, and which one.
 *
 * The Program page shows the Run panel, and a click on it changes nothing
 * that page renders — the unresolved count only falls when a Match lands, so
 * without this the page re-renders identically and the click looks lost.
 */
export async function activeRun(
  db: Database,
  programId: string,
): Promise<{ id: string; subjectLabel: string | null; queued: number; running: number } | null> {
  const [row] = await db
    .select({
      id: t.run.id,
      subjectLabel: t.run.subjectLabel,
      queued: sql<number>`count(*) filter (where ${t.job.state} = 'queued')::int`,
      running: sql<number>`count(*) filter (where ${t.job.state} = 'running')::int`,
    })
    .from(t.run)
    .innerJoin(t.job, eq(t.job.runId, t.run.id))
    .where(and(eq(t.run.programId, programId), inArray(t.job.state, ['queued', 'running'])))
    .groupBy(t.run.id, t.run.subjectLabel, t.run.createdAt)
    .orderBy(desc(t.run.createdAt))
    .limit(1);

  return row ?? null;
}

/**
 * What the roster still needs, stage by stage (SPEC §4.3).
 *
 * The pipeline is **resolve → enrich → assess**, and only the first hop is
 * chained: the worker queues an `enrich` when a Match is accepted, and nothing
 * queues an `assess` at all. So a roster can sit fully resolved with no
 * criterion values and no assessments, and the Program page's only Run
 * affordance — "N suppliers have no settled match yet" — goes quiet at exactly
 * the point there is most left to do.
 *
 * Counted per stage rather than as one number, because the three cost
 * differently: enrichment runs no model at all, and an assessment is the only
 * one of the three that argues.
 */
export type RosterWork = {
  /** No Match row at all. */
  unresolved: number;
  /** Match accepted, but no criterion has a value — nothing has been fetched. */
  unenriched: number;
  /** Criterion values exist, but no standard Assessment has been written. */
  unassessed: number;
};

export async function rosterWork(db: Database, programId: string): Promise<RosterWork> {
  const suppliers = await db
    .select({ id: t.supplier.id, matchStatus: t.match.status })
    .from(t.supplier)
    .leftJoin(t.match, eq(t.match.supplierId, t.supplier.id))
    .where(eq(t.supplier.programId, programId));

  const scored = await db
    .select({ supplierId: t.criterionValue.supplierId })
    .from(t.criterionValue)
    .innerJoin(t.supplier, eq(t.supplier.id, t.criterionValue.supplierId))
    .where(eq(t.supplier.programId, programId));
  const hasValues = new Set(scored.map((row) => row.supplierId));

  const assessed = await db
    .select({ supplierId: t.assessment.supplierId })
    .from(t.assessment)
    .where(and(eq(t.assessment.programId, programId), eq(t.assessment.kind, 'standard')));
  const hasAssessment = new Set(assessed.map((row) => row.supplierId));

  return {
    unresolved: suppliers.filter((row) => row.matchStatus == null).length,
    unenriched: suppliers.filter(
      (row) => row.matchStatus === 'accepted' && !hasValues.has(row.id),
    ).length,
    unassessed: suppliers.filter((row) => hasValues.has(row.id) && !hasAssessment.has(row.id)).length,
  };
}

/** The Suppliers a roster-wide enrich or assess would actually queue. */
export async function suppliersNeeding(
  db: Database,
  programId: string,
  stage: 'enrich' | 'assess',
  limit: number,
): Promise<string[]> {
  const suppliers = await db
    .select({ id: t.supplier.id, rosterIndex: t.supplier.rosterIndex, matchStatus: t.match.status })
    .from(t.supplier)
    .leftJoin(t.match, eq(t.match.supplierId, t.supplier.id))
    .where(eq(t.supplier.programId, programId))
    .orderBy(t.supplier.rosterIndex);

  const scored = await db
    .select({ supplierId: t.criterionValue.supplierId })
    .from(t.criterionValue)
    .innerJoin(t.supplier, eq(t.supplier.id, t.criterionValue.supplierId))
    .where(eq(t.supplier.programId, programId));
  const hasValues = new Set(scored.map((row) => row.supplierId));

  if (stage === 'enrich') {
    return suppliers
      .filter((row) => row.matchStatus === 'accepted' && !hasValues.has(row.id))
      .slice(0, limit)
      .map((row) => row.id);
  }

  const assessed = await db
    .select({ supplierId: t.assessment.supplierId })
    .from(t.assessment)
    .where(and(eq(t.assessment.programId, programId), eq(t.assessment.kind, 'standard')));
  const hasAssessment = new Set(assessed.map((row) => row.supplierId));

  return suppliers
    .filter((row) => hasValues.has(row.id) && !hasAssessment.has(row.id))
    .slice(0, limit)
    .map((row) => row.id);
}

/**
 * A Run broken into the phases it is passing through (SPEC §5.1).
 *
 * A pipeline Run's Job list *grows*: fifty resolves become fifty resolves plus
 * forty-eight enriches plus forty-eight assessments, queued as each phase
 * succeeds. One "N of M" over that whole set steps backwards every time the
 * next phase appears, which reads as the run losing ground when it is in fact
 * getting further. Split by kind and each bar only ever fills.
 *
 * Ordered by the pipeline, not by count, so the phases read left to right in
 * the order they happen.
 */
const PHASE_ORDER = ['resolve', 'enrich', 'assess', 'recommend', 'discover', 'traverse', 'dossier'];

export type RunPhase = { kind: string; progress: RunProgress };

export function runPhases(jobs: { kind: string; state: typeof t.job.$inferSelect.state }[]): RunPhase[] {
  const kinds = [...new Set(jobs.map((job) => job.kind))].sort(
    (a, b) => PHASE_ORDER.indexOf(a) - PHASE_ORDER.indexOf(b),
  );
  return kinds.map((kind) => ({
    kind,
    progress: runProgress(jobs.filter((job) => job.kind === kind)),
  }));
}

/**
 * Jobs that stopped without finishing, and could be put back.
 *
 * `failed` is the obvious one. `running` with no worker alive is the one that
 * caught us out: a worker killed mid-Job leaves its row claimed for ever, the
 * Run never settles, and the page shows a phase that is permanently one job
 * short with nothing to click.
 */
export function retryableJobs(
  jobs: (typeof t.job.$inferSelect)[],
  workerUp: boolean,
  nowMs: number,
): (typeof t.job.$inferSelect)[] {
  return jobs.filter((job) => {
    if (job.state === 'failed' || job.state === 'terminated') return true;
    if (job.state !== 'running') return false;
    /**
     * **A long Job is not a dead Job, and `workerSeemsUp` cannot tell them
     * apart.** That check reads the newest `started_at` in the table, so a
     * worker chewing through one forty-minute assessment starts nothing new and
     * looks, to that query, exactly like a worker that has exited. It marked a
     * healthy running Job `stranded` and offered a retry — and a retry of a Job
     * that is still running spends its whole cost a second time.
     *
     * There is no heartbeat to consult, so the threshold does the work instead:
     * far longer than any Job this app runs, and only then combined with the
     * liveness signal. Being slow to offer the recovery is the safe direction;
     * offering it early spends money.
     */
    const startedMs = job.startedAt?.getTime();
    return !workerUp && startedMs != null && nowMs - startedMs > STRANDED_AFTER_MS;
  });
}

/** Longer than any Job here takes, because the cost of guessing early is a double spend. */
const STRANDED_AFTER_MS = 30 * 60 * 1000;

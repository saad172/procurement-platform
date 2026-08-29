import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as t from '@/db/schema';
import type { DiscriminatorResult } from './discriminators';

/**
 * `settleMatch()` — the third chokepoint (SPEC §2.4, §15.4).
 *
 * **The agents propose and our code settles.** So the invariant is not "no
 * `submit_match` tool reachable from chat" but the stronger:
 *
 *   > **No tool in the registry, on any surface, writes `match.status` or
 *   > `match.entity_id`.**
 *
 * Enforced by an **ESLint import boundary** — `src/tools/**` may not import
 * this module — rather than by a test, because the failure it exists to stop is
 * *a tool added later without thinking about it*, which no amount of iterating
 * over `defineTool` results can see.
 *
 * Every settlement writes a **new `match_attempt`**, which is why the table is
 * append-only: an override after an agent accept must show **both**
 * settlements, not one overwriting the other.
 */

export type SettledBy = 'rules' | 'agents' | 'human' | 'discovered';

export type CandidateRecord = {
  entityId: string;
  foundByRung: string;
  queryProvenance?: string | undefined;
  score?: number | undefined;
  matchStrength?: string | undefined;
  explanation?: unknown;
  /** Keyed by who reported them: `rules`, `resolver`, `evaluator`. */
  verdicts: { reportedBy: string; results: DiscriminatorResult[] }[];
};

export type Settlement = {
  supplierId: string;
  status: 'accepted' | 'needs_review' | 'not_found';
  entityId: string | null;
  settledBy: SettledBy;
  matchStrength?: string | undefined;
  jobId?: string | undefined;
  threadMessageId?: string | undefined;
  note?: string | undefined;
  rungsUsed?: string[] | undefined;
  candidates?: CandidateRecord[] | undefined;
};

/**
 * Settles one Supplier's Match, appending an attempt and its candidates.
 *
 * A promoted Lead arrives here with `settledBy: 'discovered'` and **zero
 * candidates**, which is what keeps `match` **total over Suppliers** — so the
 * scoring bands, the lifecycle and the Excluded block need no fourth case.
 */
export async function settleMatch(db: Database, settlement: Settlement): Promise<{ matchId: string; attemptId: string }> {
  return db.transaction(async (tx) => {
    const existing = await tx.query.match.findFirst({
      where: eq(t.match.supplierId, settlement.supplierId),
    });

    const matchId = existing
      ? (await tx
          .update(t.match)
          .set({
            status: settlement.status,
            entityId: settlement.entityId,
            settledBy: settlement.settledBy,
            matchStrength: settlement.matchStrength ?? null,
            settledAt: new Date(),
          })
          .where(eq(t.match.id, existing.id))
          .returning({ id: t.match.id }))[0]!.id
      : (await tx
          .insert(t.match)
          .values({
            supplierId: settlement.supplierId,
            status: settlement.status,
            entityId: settlement.entityId,
            settledBy: settlement.settledBy,
            matchStrength: settlement.matchStrength ?? null,
          })
          .returning({ id: t.match.id }))[0]!.id;

    // Append-only: the next attempt number, never an overwrite.
    const [{ next }] = (await tx
      .select({ next: sql<number>`coalesce(max(${t.matchAttempt.attemptN}), 0) + 1` })
      .from(t.matchAttempt)
      .where(eq(t.matchAttempt.matchId, matchId))) as [{ next: number }];

    const [attempt] = await tx
      .insert(t.matchAttempt)
      .values({
        matchId,
        jobId: settlement.jobId ?? null,
        attemptN: next,
        rungsUsed: (settlement.rungsUsed ?? []) as never,
        outcomeStatus: settlement.status,
        outcomeEntityId: settlement.entityId,
        settledBy: settlement.settledBy,
        threadMessageId: settlement.threadMessageId ?? null,
        note: settlement.note ?? null,
      })
      .returning({ id: t.matchAttempt.id });

    for (const candidate of settlement.candidates ?? []) {
      const [row] = await tx
        .insert(t.matchCandidate)
        .values({
          matchAttemptId: attempt!.id,
          entityId: candidate.entityId,
          foundByRung: candidate.foundByRung,
          // Why a query term was tried, so the Trace shows the provenance of the
          // search instead of the term appearing from nowhere.
          queryProvenance: candidate.queryProvenance ?? null,
          score: candidate.score?.toString() ?? null,
          matchStrength: candidate.matchStrength ?? null,
          explanation: (candidate.explanation ?? null) as never,
        })
        .onConflictDoNothing({ target: [t.matchCandidate.matchAttemptId, t.matchCandidate.entityId] })
        .returning({ id: t.matchCandidate.id });

      if (!row) continue;
      // BOTH agents' per-Discriminator verdicts are stored: the blind evaluator
      // naming a different company is the interesting artefact, and it has to be
      // readable afterwards.
      for (const reported of candidate.verdicts) {
        for (const result of reported.results) {
          await tx
            .insert(t.matchCandidateVerdict)
            .values({
              matchCandidateId: row.id,
              discriminator: result.discriminator,
              verdict: result.verdict,
              reasoning: result.reasoning,
              reportedBy: reported.reportedBy,
            })
            .onConflictDoNothing();
        }
      }
    }

    return { matchId, attemptId: attempt!.id };
  });
}

/**
 * A promoted Lead gets a **pre-settled Match**: `accepted`,
 * `settled_by: 'discovered'`, zero attempts' worth of candidates.
 *
 * The UI renders *Identity: discovered*, never *verified*, and a null
 * `matchStrength` reads as strong — because no name matching happened for it to
 * be weak at.
 */
export async function settleDiscoveredLead(
  db: Database,
  args: { supplierId: string; entityId: string },
): Promise<{ matchId: string; attemptId: string }> {
  return settleMatch(db, {
    supplierId: args.supplierId,
    status: 'accepted',
    entityId: args.entityId,
    settledBy: 'discovered',
    note: 'Promoted from a lead. No name matching happened, so there is no match strength to report.',
  });
}

/** Every candidate ever seen for a Supplier, across attempts. */
export async function candidatesSeen(db: Database, supplierId: string): Promise<string[]> {
  const rows = await db
    .select({ entityId: t.matchCandidate.entityId })
    .from(t.matchCandidate)
    .innerJoin(t.matchAttempt, eq(t.matchAttempt.id, t.matchCandidate.matchAttemptId))
    .innerJoin(t.match, and(eq(t.match.id, t.matchAttempt.matchId), eq(t.match.supplierId, supplierId)));
  return [...new Set(rows.map((r) => r.entityId))];
}

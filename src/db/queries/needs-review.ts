import { desc, eq, inArray } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as t from '@/db/schema';
import type { CandidateForChoice } from '@/domain/settle-choices';

/**
 * The Needs Review branch's queries (SPEC §6.8).
 *
 * **Cached-first, expensive-on-demand.** Everything here is already stored: the
 * legal name, the address, the LEI or none, the distinct source count, and the
 * verdict every Discriminator reached against every Candidate. Nothing on this
 * branch spends a Sayari credit, because a review page that charged for being
 * *opened* would be charging for curiosity.
 */

export type ParkedRow = {
  supplier: typeof t.supplier.$inferSelect;
  match: typeof t.match.$inferSelect;
  candidateCount: number;
  /** The most recent settlement, when an agent already tried and parked it. */
  lastAttempt: typeof t.matchAttempt.$inferSelect | undefined;
};

/** Every roster row a person still has to settle, in roster order. */
export async function loadParked(db: Database, programId: string): Promise<ParkedRow[]> {
  const rows = await db
    .select({ supplier: t.supplier, match: t.match })
    .from(t.supplier)
    .innerJoin(t.match, eq(t.match.supplierId, t.supplier.id))
    .where(eq(t.supplier.programId, programId));

  const waiting = rows
    .filter((row) => row.match.status !== 'accepted')
    .sort((a, b) => (a.supplier.rosterIndex ?? 0) - (b.supplier.rosterIndex ?? 0));
  if (waiting.length === 0) return [];

  const matchIds = waiting.map((w) => w.match.id);
  const attempts = await db
    .select()
    .from(t.matchAttempt)
    .where(inArray(t.matchAttempt.matchId, matchIds))
    .orderBy(desc(t.matchAttempt.attemptN));

  const candidates = attempts.length
    ? await db
        .select({ id: t.matchCandidate.id, attemptId: t.matchCandidate.matchAttemptId })
        .from(t.matchCandidate)
        .where(inArray(t.matchCandidate.matchAttemptId, attempts.map((a) => a.id)))
    : [];

  return waiting.map(({ supplier, match }) => {
    const mine = attempts.filter((a) => a.matchId === match.id);
    const ids = new Set(mine.map((a) => a.id));
    return {
      supplier,
      match,
      candidateCount: candidates.filter((c) => ids.has(c.attemptId)).length,
      lastAttempt: mine[0],
    };
  });
}

export type ParkedDetail = {
  programName: string;
  supplier: typeof t.supplier.$inferSelect;
  match: typeof t.match.$inferSelect;
  candidates: CandidateForChoice[];
  /** Every settlement so far, newest first — an override shows both. */
  attempts: (typeof t.matchAttempt.$inferSelect)[];
};

/**
 * One parked row, with every Candidate any attempt ever recorded for it.
 *
 * **Scoped to the Program in the URL.** A Supplier reached through the wrong
 * Program is not this Program's row, and rendering it anyway would let a
 * hand-edited URL cross a boundary the rest of the app keeps — the same rule
 * `loadSentenceEvidence` applies to a Citation.
 */
export async function loadParkedRow(
  db: Database,
  args: { programId: string; supplierId: string },
): Promise<ParkedDetail | null> {
  const program = await db.query.program.findFirst({ where: eq(t.program.id, args.programId) });
  if (!program) return null;

  const supplier = await db.query.supplier.findFirst({ where: eq(t.supplier.id, args.supplierId) });
  if (!supplier || supplier.programId !== args.programId) return null;

  const match = await db.query.match.findFirst({ where: eq(t.match.supplierId, supplier.id) });
  if (!match) return null;

  const attempts = await db
    .select()
    .from(t.matchAttempt)
    .where(eq(t.matchAttempt.matchId, match.id))
    .orderBy(desc(t.matchAttempt.attemptN));

  const rows = attempts.length
    ? await db
        .select({ candidate: t.matchCandidate, entity: t.entity })
        .from(t.matchCandidate)
        .innerJoin(t.entity, eq(t.entity.id, t.matchCandidate.entityId))
        .where(inArray(t.matchCandidate.matchAttemptId, attempts.map((a) => a.id)))
    : [];

  const verdicts = rows.length
    ? await db
        .select()
        .from(t.matchCandidateVerdict)
        .where(inArray(t.matchCandidateVerdict.matchCandidateId, rows.map((r) => r.candidate.id)))
    : [];

  /**
   * Candidates accumulate **across attempts**, and the same entity may be
   * recorded under two of them. One row per entity here, carrying every verdict
   * any attempt reached — which is what lets two reads of the same record show
   * as a dispute rather than as two candidates.
   */
  const byEntity = new Map<string, CandidateForChoice>();
  for (const { candidate, entity } of rows) {
    const mine = verdicts
      .filter((v) => v.matchCandidateId === candidate.id)
      .map((v) => ({
        discriminator: v.discriminator,
        verdict: v.verdict,
        reasoning: v.reasoning,
        reportedBy: v.reportedBy,
      }));

    const existing = byEntity.get(entity.id);
    if (existing) {
      existing.verdicts.push(...mine);
      continue;
    }
    byEntity.set(entity.id, {
      entityId: entity.id,
      label: entity.label,
      city: entity.city,
      country: entity.country,
      addressLine: entity.addressLine,
      lei: entity.lei,
      distinctSourceCount: entity.distinctSourceCount,
      foundByRung: candidate.foundByRung,
      queryProvenance: candidate.queryProvenance,
      verdicts: mine,
    });
  }

  return {
    programName: program.name,
    supplier,
    match,
    candidates: [...byEntity.values()],
    attempts,
  };
}

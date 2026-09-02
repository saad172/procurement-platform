import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as t from '@/db/schema';
import { derivedId } from '@/db/derived-id';
import { toAlpha3 } from '@/domain/iso3166';
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

/**
 * What the settler knows about **where the settled Candidate actually is**.
 *
 * Only a settler that ran the Discriminators has this: the rules gate and the
 * agent Rounds do, a human override and a promoted Lead do not. Absent, the
 * settled country falls back to the Profile's own, which is exactly what those
 * two paths can honestly say.
 */
export type SettledEvidence = {
  /** The LEI on the settled Candidate's record, if it carries one. */
  lei: string | null;
  /** GLEIF's own legal-address country for that LEI — ISO2 as GLEIF gives it. */
  gleifLegalCountry: string | null;
  /** The country of the one recorded address the three address rungs anchored on. */
  anchoredAddressCountry: string | null;
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
  /** See `SettledEvidence`. Absent on the human and discovered paths. */
  settledEvidence?: SettledEvidence | undefined;
};

export type CountrySource = 'gleif' | 'matched_address' | 'profile';

/**
 * **The country this Match is scored on** (SPEC §9.4, finding 107).
 *
 * Three sources, in order of what each one actually witnesses:
 *
 * 1. **GLEIF's legal-address country**, where the settled Candidate has an LEI
 *    and a GLEIF record. An independent register saying where this legal person
 *    is registered.
 * 2. **The anchored address's country** — the country of the one recorded
 *    address the three address rungs agreed on. That address is the building
 *    the Match is *about*, so its country is the site's.
 * 3. **The Profile's own country**, which is Sayari's `countries[0]` or its
 *    first address's, and is a fact about the *record*. Measured: ten of fifty
 *    accepted Matches carry one that disagrees with the roster row the country
 *    Discriminator had just agreed with, and Sumitomo Electric's reads `SWE`
 *    against a Japanese address — so `country_resilience` and the tariff origin
 *    were both scored on Sweden.
 *
 * The rule this replaces was "the roster's country whenever the country
 * Discriminator passed", which was right about the ten and wrong in principle:
 * it scored *what the roster claimed* rather than what any source witnessed,
 * and it had nothing to say when the Discriminator did not pass.
 */
export function deriveSettledCountry(args: {
  evidence?: SettledEvidence | undefined;
  profileCountry: string | null;
}): { country: string | null; source: CountrySource | null } {
  const { evidence } = args;

  if (evidence?.lei) {
    const gleif = toAlpha3(evidence.gleifLegalCountry);
    if (gleif) return { country: gleif, source: 'gleif' };
  }
  const anchored = toAlpha3(evidence?.anchoredAddressCountry);
  if (anchored) return { country: anchored, source: 'matched_address' };

  const profile = toAlpha3(args.profileCountry);
  return profile ? { country: profile, source: 'profile' } : { country: null, source: null };
}

/**
 * The one `match` row per Supplier, inserted or updated, carrying the country
 * this settlement decided to score on.
 *
 * The Profile's own country is read inside the same transaction so the fallback
 * is the row this settlement is about to point at, and not a value the caller
 * happened to be holding. A parked Match has no entity and therefore no site:
 * the two country columns stay null, which reads as *fall back to the
 * Profile's* rather than as *no country*.
 */
async function upsertMatchRow(
  tx: Parameters<Parameters<Database['transaction']>[0]>[0],
  settlement: Settlement,
): Promise<string> {
  const existing = await tx.query.match.findFirst({
    where: eq(t.match.supplierId, settlement.supplierId),
  });

  const profileCountry = settlement.entityId
    ? ((await tx.query.entity.findFirst({ where: eq(t.entity.id, settlement.entityId) }))
        ?.country ?? null)
    : null;
  const settled = settlement.entityId
    ? deriveSettledCountry({ evidence: settlement.settledEvidence, profileCountry })
    : { country: null, source: null };

  const values = {
    status: settlement.status,
    entityId: settlement.entityId,
    settledBy: settlement.settledBy,
    matchStrength: settlement.matchStrength ?? null,
    settledCountry: settled.country,
    settledCountrySource: settled.source,
  };

  if (existing) {
    const [row] = await tx
      .update(t.match)
      .set({ ...values, settledAt: new Date() })
      .where(eq(t.match.id, existing.id))
      .returning({ id: t.match.id });
    return row!.id;
  }
  const [row] = await tx
    .insert(t.match)
    .values({
      // One Match per Supplier, upserted — so the Supplier IS the key.
      id: derivedId('match', settlement.supplierId, 0),
      supplierId: settlement.supplierId,
      ...values,
    })
    .returning({ id: t.match.id });
  return row!.id;
}

/**
 * Settles one Supplier's Match, appending an attempt and its candidates.
 *
 * A promoted Lead arrives here with `settledBy: 'discovered'` and **zero
 * candidates**, which is what keeps `match` **total over Suppliers** — so the
 * scoring bands, the lifecycle and the Excluded block need no fourth case.
 */
export async function settleMatch(
  db: Database,
  settlement: Settlement,
): Promise<{ matchId: string; attemptId: string }> {
  return db.transaction(async (tx) => {
    const matchId = await upsertMatchRow(tx, settlement);

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
        .onConflictDoNothing({
          target: [t.matchCandidate.matchAttemptId, t.matchCandidate.entityId],
        })
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

/**
 * The attempt number the next settlement of this Supplier will carry.
 *
 * `settleMatch` computes the same number the same way inside its transaction;
 * this is for callers that need it *before* they settle — the shuffle seed is
 * `(supplierId, attemptN, roundN)`, and the ordering has to be fixed before the
 * first Round runs (SPEC §19.1).
 */
export async function nextAttemptNumber(db: Database, supplierId: string): Promise<number> {
  const [row] = await db
    .select({ next: sql<number>`coalesce(max(${t.matchAttempt.attemptN}), 0) + 1` })
    .from(t.matchAttempt)
    .innerJoin(t.match, eq(t.match.id, t.matchAttempt.matchId))
    .where(eq(t.match.supplierId, supplierId));
  return Number(row?.next ?? 1);
}

/** Every candidate ever seen for a Supplier, across attempts. */
export async function candidatesSeen(db: Database, supplierId: string): Promise<string[]> {
  const rows = await db
    .select({ entityId: t.matchCandidate.entityId })
    .from(t.matchCandidate)
    .innerJoin(t.matchAttempt, eq(t.matchAttempt.id, t.matchCandidate.matchAttemptId))
    .innerJoin(
      t.match,
      and(eq(t.match.id, t.matchAttempt.matchId), eq(t.match.supplierId, supplierId)),
    );
  return [...new Set(rows.map((r) => r.entityId))];
}

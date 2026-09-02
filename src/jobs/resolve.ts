import { eq } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as t from '@/db/schema';
import { MAX_ROUNDS } from '@/config/constants';
import { evaluateAutoAccept, type CandidateAssessment } from '@/domain/match/auto-accept';
import {
  nameTokensOf,
  runDiscriminators,
  type CandidateFacts,
  type RosterRow,
} from '@/domain/match/discriminators';
import { sameCountry } from '@/domain/match/address-ladder';
import { seedFor, shuffleCandidates } from '@/domain/match/shuffle';
import { ownersOf, parseRelationships } from '@/domain/parse-relationships';
import { compareAddresses } from '@/domain/match/address-ladder';
import {
  nextAttemptNumber,
  settleMatch,
  type CandidateRecord,
  type SettledEvidence,
} from '@/domain/match/settle-match';
import type { Upstream } from '@/upstream';
import {
  attributeTexts,
  matchStrengthValue,
  type SayariEntity,
} from '@/upstream/projections/sayari';

/**
 * The resolve Job (SPEC §6).
 *
 * ```
 * bulk resolutionPost (all rows, ONE call, enableLlmClean: true)
 *       │
 *       ▼
 * eight Discriminators run IN CODE, per Candidate
 *       │
 *       ├── exactly one passes all eight AND a GLEIF exact-LEI join agrees
 *       │        → accepted, settled_by='rules', zero Rounds, ZERO TOKENS
 *       │
 *       └── otherwise → Round 1..3
 *                 resolver  (carries memory; sees the objection; picks a rung)
 *                 evaluator (blind, stateless, shuffled candidates)
 *                 same entity_id → accepted, settled_by='agents'
 *                 differ        → next rung, up to MAX_ROUNDS
 *                               → needs_review  (a Candidate in-country was seen)
 *                               → not_found     (none ever was)
 * ```
 *
 * **Agreement is our code comparing two entity ids.** The shuffle, the blinding,
 * the Round counter and the schema check are functions here, not instructions in
 * a prompt — which is the whole reason the evaluator loop is worth having.
 */

/** Projects a Sayari entity into the flat facts the Discriminators read. */
export function toCandidateFacts(
  entity: SayariEntity,
  gleif?: CandidateFacts['gleif'],
): CandidateFacts {
  // EVERY address, not just the first: a large company carries many, and the
  // roster's city is often not the one listed first.
  //
  // `line` rides along because the street rung reads it. It is Sayari's
  // `properties.value`, the whole address as one string, and it is the only
  // field that says which *building* — `city` and `postcode` say which town.
  const addressBlocks = entity.attributes?.address?.data ?? [];
  const addresses = addressBlocks
    .map((a) => ({
      city: a.properties?.city ?? null,
      postcode: a.properties?.postcode ?? null,
      country: a.properties?.country ?? null,
      line: typeof a.properties?.value === 'string' ? a.properties.value : null,
    }))
    .filter((a) => a.city != null || a.postcode != null || a.country != null || a.line != null);
  const properties = addressBlocks[0]?.properties;
  const aliasBlock = entity.attributes?.name?.data ?? [];

  /**
   * The current one-hop **upward** owners named in this record's own payload.
   *
   * `name_cover` reads them to tell a family member from the company the roster
   * meant. Parsed here rather than in the Discriminators so that module stays
   * pure over flat facts, and through `parseRelationships`/`ownersOf` rather
   * than a second reader, because direction is exactly what a second reader
   * gets wrong (`src/domain/relationships.ts`).
   */
  const owners = ownersOf(parseRelationships(entity, entity.id).edges).map((edge) => ({
    entityId: edge.targetId,
    label: edge.targetLabel,
  }));

  const latestStatus =
    entity.latest_status && typeof entity.latest_status === 'object'
      ? (((entity.latest_status as { status?: unknown }).status as string | undefined) ?? null)
      : null;

  return {
    entityId: entity.id,
    label: entity.label,
    // From `attributes.address`, NEVER the first entry of the multi-valued
    // `countries[]` — one seeded company returned eight.
    country: properties?.country ?? entity.countries?.[0] ?? null,
    addresses:
      addresses.length > 0
        ? addresses
        : [{ city: null, postcode: null, country: entity.countries?.[0] ?? null, line: null }],
    aliases: attributeTexts(aliasBlock),
    businessPurposes: attributeTexts(entity.attributes?.business_purpose?.data),
    companyType: entity.company_type ?? null,
    closed: entity.closed ?? false,
    latestStatus,
    lei: typeof entity.lei === 'string' ? entity.lei : findLei(entity),
    gleif,
    owners,
    // An owner absent from a truncated window is not an absent owner, and
    // `name_cover` says which of the two it is looking at.
    relationshipsTruncated: relationshipsTruncated(entity),
  };
}

/**
 * Projects the entity block of a GLEIF record into the witness the Discriminators
 * read.
 *
 * `jurisdiction` and `headquartersAddress.city` were both in the projection and
 * neither was read until the LEI witness needed them: the jurisdiction is the
 * one field a subsidiary cannot borrow from its parent, and the headquarters
 * city is where a Delaware corporation keeps the city it actually operates in.
 */
export function toGleifWitness(
  entity:
    | {
        legalName?: { name?: string | null } | null;
        jurisdiction?: string | null;
        legalAddress?: { city?: string | null; country?: string | null } | null;
        headquartersAddress?: { city?: string | null } | null;
      }
    | null
    | undefined,
): CandidateFacts['gleif'] {
  return {
    legalName: entity?.legalName?.name ?? null,
    jurisdiction: entity?.jurisdiction ?? null,
    legalCity: entity?.legalAddress?.city ?? null,
    legalCountry: entity?.legalAddress?.country ?? null,
    hqCity: entity?.headquartersAddress?.city ?? null,
  };
}

/** The LEI is an identifier among many, not a top-level field. */
function findLei(entity: SayariEntity): string | null {
  for (const identifier of entity.identifiers ?? []) {
    if (!identifier || typeof identifier !== 'object') continue;
    const row = identifier as { type?: unknown; value?: unknown };
    if (typeof row.type === 'string' && /lei/i.test(row.type) && typeof row.value === 'string') {
      return row.value;
    }
  }
  return null;
}

export type ResolveDeps = {
  db: Database;
  upstream: Upstream;
  /**
   * Runs one agent Round. Supplied by the caller so the deterministic half of
   * this Job — the Discriminators, the gate, the shuffle — is testable without
   * a model, and so the model half goes through `runLoop()` and nowhere else.
   */
  runRound?: (args: {
    roster: RosterRow;
    candidates: CandidateFacts[];
    roundN: number;
    objection: string | undefined;
    /** The blind evaluator sees these SHUFFLED and nothing else. */
    shuffledForEvaluator: CandidateFacts[];
  }) => Promise<{
    resolverPick: string | null;
    evaluatorPick: string | null;
    resolverVerdicts: ReturnType<typeof runDiscriminators>;
    evaluatorVerdicts: ReturnType<typeof runDiscriminators>;
    objection: string | undefined;
    /** Which rungs the Round actually climbed — measured, never assumed. */
    rungsUsed: string[];
    /**
     * Every entity id the Round looked at, **with the rung that surfaced it**,
     * including its picks.
     *
     * The rung tools hand candidates straight to the model, so without this the
     * Job never learns they exist — and a Job that agrees on a company it has
     * not stored cannot settle, because `match.entity_id` is a foreign key.
     *
     * The rung travels with the id rather than being taken from the Round,
     * because "what did it take to find this Candidate" is a question about the
     * Candidate. Stamping the highest rung the Round reached onto everything it
     * saw answers it wrongly for every id the earlier rungs returned.
     */
    entityIdsSeen: { entityId: string; rung: string }[];
  }>;
};

export type ResolveOutcome = {
  status: 'accepted' | 'needs_review' | 'not_found';
  entityId: string | null;
  settledBy: 'rules' | 'agents';
  rounds: number;
  reason: string;
};

/**
 * Resolves one Supplier.
 *
 * The **batch pre-pass is a Job step, not a tool** (SPEC §15.6): it fans out
 * over every roster row in one call, and a tool that returned fifty rows for
 * one Supplier would be a tool doing something other than what it is named for.
 * The caller runs it once and hands the candidates here.
 */
export async function resolveSupplier(
  deps: ResolveDeps,
  args: {
    supplierId: string;
    roster: RosterRow;
    /** Entity ids from the batch pre-pass (rung R1). */
    prepassEntityIds: string[];
    jobId?: string | undefined;
  },
): Promise<ResolveOutcome> {
  const candidates = await gatherPrepassCandidates(deps, args);

  const gate = await runAutoAcceptGate(deps.db, args, candidates);
  if (gate.outcome) return gate.outcome;

  const rounds = await runAgentRounds(deps, args, candidates, gate);
  if (rounds.outcome) return rounds.outcome;

  return settleNonConvergence(deps.db, args, rounds.state);
}

/** Gather the candidates the pre-pass proposed, with their GLEIF witness. */
async function gatherPrepassCandidates(
  deps: Pick<ResolveDeps, 'db' | 'upstream'>,
  args: { prepassEntityIds: string[] },
): Promise<CandidateFacts[]> {
  const { db, upstream } = deps;
  const candidates: CandidateFacts[] = [];
  for (const entityId of args.prepassEntityIds) {
    const fetched = await upstream.sayari.getEntity({ id: entityId });
    const facts = toCandidateFacts(fetched.data);
    if (facts.lei) {
      // The second witness, fetched only where there is an LEI to join on.
      try {
        const gleif = await upstream.gleif.joinLei({ lei: facts.lei });
        facts.gleif = toGleifWitness(gleif.data.data?.attributes?.entity);
      } catch {
        // A GLEIF miss leaves `gleif` undefined, which reads as `unavailable`
        // rather than as a failure — absence is not evidence.
      }
    }
    candidates.push(facts);
    await upsertEntity(db, fetched.data, fetched.upstreamResponseId);
  }
  return candidates;
}

type AutoAcceptGateResult =
  | { outcome: ResolveOutcome }
  | { outcome: null; gateReason: string; ruleCandidateRecords: CandidateRecord[] };

/**
 * ── The auto-accept gate: plain code, zero tokens ──────────────────────────
 *
 * Settles and returns an outcome when the gate accepts; otherwise hands back
 * the gate's reason and its own-code Discriminator records, which the
 * no-agent fallback below (`runAgentRounds`) needs verbatim if there is no
 * `runRound` to hand off to.
 */
async function runAutoAcceptGate(
  db: Database,
  args: { supplierId: string; roster: RosterRow; jobId?: string | undefined },
  candidates: CandidateFacts[],
): Promise<AutoAcceptGateResult> {
  const assessments: CandidateAssessment[] = candidates.map((candidate) => ({
    candidate,
    verdicts: runDiscriminators(args.roster, candidate),
  }));
  const gate = evaluateAutoAccept(assessments);

  const ruleCandidateRecords: CandidateRecord[] = assessments.map((a) => ({
    entityId: a.candidate.entityId,
    foundByRung: 'R1',
    queryProvenance: 'batch resolution pre-pass over the roster row',
    verdicts: [{ reportedBy: 'rules', results: a.verdicts }],
  }));

  if (gate.accepted) {
    const settled = candidates.find((c) => c.entityId === gate.entityId)!;
    await settleMatch(db, {
      supplierId: args.supplierId,
      status: 'accepted',
      entityId: gate.entityId,
      settledBy: 'rules',
      jobId: args.jobId,
      rungsUsed: ['R1'],
      note: gate.reason,
      settledEvidence: settledEvidenceFor(args.roster, settled),
      candidates: ruleCandidateRecords,
    });
    return {
      outcome: {
        status: 'accepted',
        entityId: gate.entityId,
        settledBy: 'rules',
        rounds: 0,
        reason: gate.reason,
      },
    };
  }

  return { outcome: null, gateReason: gate.reason, ruleCandidateRecords };
}

type NonConvergenceState = {
  seen: CandidateFacts[];
  rungsUsed: string[];
  lastRound: Awaited<ReturnType<NonNullable<ResolveDeps['runRound']>>> | undefined;
  foundByRung: Map<string, string>;
};

/**
 * ── The agent Rounds ────────────────────────────────────────────────────────
 *
 * Two ways in: no agent to hand off to, so the row parks on the gate's own
 * reason (`settleWithoutAgent`); or an agent, so the ladder runs
 * (`runRoundLadder`), which settles and returns an outcome for a Round that
 * converges, or the state `settleNonConvergence` needs once it runs out.
 */
async function runAgentRounds(
  deps: ResolveDeps,
  args: { supplierId: string; roster: RosterRow; jobId?: string | undefined },
  candidates: CandidateFacts[],
  gate: { gateReason: string; ruleCandidateRecords: CandidateRecord[] },
): Promise<{ outcome: ResolveOutcome } | { outcome: null; state: NonConvergenceState }> {
  const { runRound } = deps;
  if (!runRound) return settleWithoutAgent(deps.db, args, candidates, gate);
  return runRoundLadder(deps, runRound, args, candidates);
}

/**
 * No agent supplied: park the row rather than guess. A parked row never
 * stalls a run — everything else finishes and the Program page reads
 * "44 of 50 assessed, 6 waiting on you".
 */
async function settleWithoutAgent(
  db: Database,
  args: { supplierId: string; roster: RosterRow; jobId?: string | undefined },
  candidates: CandidateFacts[],
  gate: { gateReason: string; ruleCandidateRecords: CandidateRecord[] },
): Promise<{ outcome: ResolveOutcome }> {
  const status = sawCandidateInCountry(args.roster, candidates) ? 'needs_review' : 'not_found';
  await settleMatch(db, {
    supplierId: args.supplierId,
    status,
    entityId: null,
    settledBy: 'rules',
    jobId: args.jobId,
    rungsUsed: ['R1'],
    note: gate.gateReason,
    candidates: gate.ruleCandidateRecords,
  });
  return {
    outcome: { status, entityId: null, settledBy: 'rules', rounds: 0, reason: gate.gateReason },
  };
}

async function runRoundLadder(
  deps: ResolveDeps,
  runRound: NonNullable<ResolveDeps['runRound']>,
  args: { supplierId: string; roster: RosterRow; jobId?: string | undefined },
  candidates: CandidateFacts[],
): Promise<{ outcome: ResolveOutcome } | { outcome: null; state: NonConvergenceState }> {
  const { db } = deps;
  const seen = [...candidates];
  let rungsUsed = ['R1'];
  let objection: string | undefined;
  /** The last Round's picks and verdicts, for the non-convergence settlement. */
  let lastRound: Awaited<ReturnType<NonNullable<ResolveDeps['runRound']>>> | undefined;

  /**
   * Which rung each Candidate came from.
   *
   * Every Candidate used to be recorded as `foundByRung: 'R1'`, which is the
   * pre-pass — true of the ones the pre-pass returned and false of every one an
   * agent climbed a rung to find. The Needs Review view reads this to say *what
   * it took to find each option*, and an answer of "R1" for all of them makes
   * the ladder look free.
   */
  const foundByRung = new Map<string, string>(candidates.map((c) => [c.entityId, 'R1']));

  /**
   * The attempt this Job is about to write.
   *
   * It is read once, before the ladder starts, because the shuffle seed needs
   * it and the shuffle has to be the same on every Round of one attempt.
   * `settleMatch` computes the same number the same way inside its transaction.
   */
  const attemptN = await nextAttemptNumber(db, args.supplierId);

  for (let roundN = 1; roundN <= MAX_ROUNDS; roundN += 1) {
    // Seeded on the Supplier, the attempt and the Round (SPEC §19.1), so a
    // replay reconstructs the same prompt and a RE-RUN does not: an attempt
    // that showed the blind evaluator the identical ordering it had already
    // answered would be re-reading its own answer.
    const seed = seedFor(args.supplierId, attemptN, roundN);
    const round = await runRound({
      roster: args.roster,
      candidates: seen,
      roundN,
      objection,
      shuffledForEvaluator: shuffleCandidates(seen, seed),
    });

    // Everything the Round found, before anything is decided about it — so the
    // agreement check below is comparing ids the Job can actually store.
    lastRound = round;

    // Each id carries the rung that surfaced it, so a Candidate an R2 search
    // returned is not recorded as having cost an R3 one.
    await absorb(deps, round.entityIdsSeen, seen, foundByRung);
    rungsUsed = [...new Set([...rungsUsed, ...round.rungsUsed])];

    // AGREEMENT IS OUR CODE COMPARING TWO ENTITY IDS. Neither agent is asked
    // whether it agrees, and neither is told what the other said.
    if (round.resolverPick && round.resolverPick === round.evaluatorPick) {
      const picked = seen.find((c) => c.entityId === round.resolverPick);
      if (!picked) {
        objection = unheldPickObjection(round.resolverPick, roundN);
        continue;
      }

      return {
        outcome: await settleAgreement(db, args, {
          picked,
          seen,
          foundByRung,
          round,
          roundN,
          rungsUsed,
        }),
      };
    }
    objection = round.objection;
  }

  return { outcome: null, state: { seen, rungsUsed, lastRound, foundByRung } };
}

/**
 * Folds a Round's discoveries into what the Job knows.
 *
 * Fetching in the Job rather than inside the Round keeps every upstream call on
 * the Job's own `usage_event` trail, and it is what makes the picked entity
 * exist locally before `settleMatch` tries to reference it.
 *
 * A fetch that fails is skipped rather than fatal: an id the agents saw but we
 * cannot re-fetch is a candidate we cannot describe, not a reason to throw away
 * a Round that otherwise succeeded. It simply never becomes a pick, because a
 * pick with no local row cannot be settled.
 */
async function absorb(
  deps: Pick<ResolveDeps, 'db' | 'upstream'>,
  found: readonly { entityId: string; rung: string }[],
  seen: CandidateFacts[],
  foundByRung: Map<string, string>,
): Promise<void> {
  for (const { entityId, rung } of found) {
    if (seen.some((candidate) => candidate.entityId === entityId)) continue;
    try {
      const fetched = await deps.upstream.sayari.getEntity({ id: entityId });
      await upsertEntity(deps.db, fetched.data, fetched.upstreamResponseId);
      seen.push(toCandidateFacts(fetched.data));
      foundByRung.set(entityId, rung);
    } catch (error) {
      console.error(`[resolve] could not absorb candidate ${entityId}:`, error);
    }
  }
}

/**
 * **An agreed id has to be a Candidate this Job holds.**
 *
 * Nothing checked. The two agents are given a candidate list and a set of rung
 * tools, and an id they both name can be one the Job never saw, one whose fetch
 * failed in `absorb`, or — since a model writes the field — one that is not an
 * entity at all. Settling on it would write a `match.entity_id` with no local
 * row, which the foreign key refuses; before the key refuses it, it is a Match
 * pointing at a company the app cannot describe.
 *
 * Treated as non-convergence rather than as an error, because that is what it
 * is: the Round produced no usable answer, and the ladder has more rungs. The
 * objection names the id so the next Round can say where it came from, and
 * proposes nothing.
 */
function unheldPickObjection(entityId: string, roundN: number): string {
  return [
    `Both independent reads named ${entityId} at round ${roundN}, and that is not one of the candidates this job holds.`,
    'It was never returned by a rung here, or its record could not be fetched. Name a candidate from the list you were given, or use a rung tool and name something it returns.',
  ].join('\n');
}

/** Settles a Round the two agents agreed on. */
async function settleAgreement(
  db: Database,
  args: { supplierId: string; roster: RosterRow; jobId?: string | undefined },
  round: {
    picked: CandidateFacts;
    seen: readonly CandidateFacts[];
    foundByRung: Map<string, string>;
    round: Awaited<ReturnType<NonNullable<ResolveDeps['runRound']>>>;
    roundN: number;
    rungsUsed: string[];
  },
): Promise<ResolveOutcome> {
  await settleMatch(db, {
    supplierId: args.supplierId,
    status: 'accepted',
    entityId: round.picked.entityId,
    settledBy: 'agents',
    jobId: args.jobId,
    rungsUsed: round.rungsUsed,
    note: `Both agents independently named ${round.picked.label} at round ${round.roundN}.`,
    settledEvidence: settledEvidenceFor(args.roster, round.picked),
    candidates: candidateRecords(args.roster, round.seen, round.foundByRung, round.round),
  });
  return {
    status: 'accepted',
    entityId: round.picked.entityId,
    settledBy: 'agents',
    rounds: round.roundN,
    reason: `Both agents independently named the same company at round ${round.roundN}.`,
  };
}

/**
 * What the settled Candidate says about **where it is**, for the country the
 * Match will be scored on (SPEC §9.4, `deriveSettledCountry`).
 *
 * The anchored address is re-derived by running the ladder again rather than
 * threaded down from the Discriminator run, because the two must be the same
 * address and the cheapest way to guarantee that is to ask the same function
 * the same question. It is pure and it costs nothing.
 */
function settledEvidenceFor(roster: RosterRow, candidate: CandidateFacts): SettledEvidence {
  const anchored = compareAddresses({
    rosterAddress: roster.address,
    rosterCountry: roster.country,
    addresses: candidate.addresses,
    // The same question, including the name tokens, or the ladder can anchor
    // on a different address here than the Discriminators anchored on.
    nameTokens: nameTokensOf(roster, candidate),
  });
  return {
    lei: candidate.lei,
    gleifLegalCountry: candidate.gleif?.legalCountry ?? null,
    anchoredAddressCountry: anchored.evidence.candidateCountry,
  };
}

/**
 * One `CandidateRecord` per Candidate the Job holds, carrying **that
 * Candidate's own verdicts**.
 *
 * ## Both agents' verdicts, per Candidate (SPEC §19.2)
 *
 * The Needs Review view exists so a person can choose between Candidates, and
 * choosing means seeing *where the two reads differed*, Discriminator by
 * Discriminator. The last Round's verdicts are attributed to the agent that
 * produced them; every other Candidate carries our own Discriminator run,
 * reported as `rules`, because neither agent named it.
 *
 * ## Why the agreement path shares this with the non-convergence one
 *
 * It did not, and the difference was a bug rather than a design. The
 * non-convergence path attributed each Round's verdicts to the Candidate the
 * agent had actually named; the agreement path wrote **the picked entity's
 * eight verdicts against every candidate row it stored**. So a Needs Review
 * page for an accepted Match showed four rejected Candidates each carrying the
 * winner's own reasoning — every one of them apparently passing all eight, and
 * the record of why they lost gone. One function, so the two cannot drift
 * again.
 */
function candidateRecords(
  roster: RosterRow,
  seen: readonly CandidateFacts[],
  foundByRung: Map<string, string>,
  round: Awaited<ReturnType<NonNullable<ResolveDeps['runRound']>>> | undefined,
): CandidateRecord[] {
  return seen.map((candidate) => {
    const verdicts: { reportedBy: string; results: ReturnType<typeof runDiscriminators> }[] = [];
    if (round?.resolverPick === candidate.entityId) {
      verdicts.push({ reportedBy: 'resolver', results: round.resolverVerdicts });
    }
    if (round?.evaluatorPick === candidate.entityId) {
      verdicts.push({ reportedBy: 'evaluator', results: round.evaluatorVerdicts });
    }
    if (verdicts.length === 0) {
      verdicts.push({ reportedBy: 'rules', results: runDiscriminators(roster, candidate) });
    }
    const rung = foundByRung.get(candidate.entityId) ?? 'R1';
    return {
      entityId: candidate.entityId,
      foundByRung: rung,
      queryProvenance:
        rung === 'R1'
          ? 'batch resolution pre-pass over the roster row'
          : `found by an agent during a Match round, at rung ${rung}`,
      verdicts,
    };
  });
}

/** ── Non-convergence: parked, and the two reasons are different ───────────── */
async function settleNonConvergence(
  db: Database,
  args: { supplierId: string; roster: RosterRow; jobId?: string | undefined },
  state: NonConvergenceState,
): Promise<ResolveOutcome> {
  const { seen, rungsUsed, lastRound, foundByRung } = state;
  const status = sawCandidateInCountry(args.roster, seen) ? 'needs_review' : 'not_found';
  await settleMatch(db, {
    supplierId: args.supplierId,
    status,
    entityId: null,
    settledBy: 'agents',
    jobId: args.jobId,
    rungsUsed,
    note:
      status === 'needs_review'
        ? `The agents did not converge in ${MAX_ROUNDS} rounds. Candidates in the roster's country were seen, so a person can choose among them.`
        : `The agents did not converge in ${MAX_ROUNDS} rounds, and no candidate in the roster's country was ever seen.`,
    /**
     * `seen`, not the pre-pass list.
     *
     * Needs Review exists so a person can choose among the candidates, and the
     * ones the agents climbed a rung to find are exactly the ones worth
     * showing. Recording only the pre-pass would hide the work that was done
     * and present a shorter list than the Round actually considered.
     */
    candidates: candidateRecords(args.roster, seen, foundByRung, lastRound),
  });
  return {
    status,
    entityId: null,
    settledBy: 'agents',
    rounds: MAX_ROUNDS,
    reason: `No agreement in ${MAX_ROUNDS} rounds.`,
  };
}

/**
 * The distinction between the two parked states (SPEC §6.1).
 *
 * `needs_review` means *a Candidate in-country was seen* and a person can pick
 * among them; `not_found` means *none ever was*. They are different asks, and
 * the Excluded block renders them differently.
 */
function sawCandidateInCountry(roster: RosterRow, candidates: readonly CandidateFacts[]): boolean {
  if (!roster.country) return candidates.length > 0;
  // `sameCountry`, not raw uppercase equality: Sayari returns `Germany` where
  // the roster says `DEU` often enough that comparing the strings decided the
  // difference between "choose among these" and "there is nothing here" on a
  // spelling. It is the same normaliser the country Discriminator uses, so the
  // two cannot disagree about what country a Candidate is in.
  return candidates.some((c) => c.country && sameCountry(roster.country!, c.country));
}

/**
 * Projects an entity into the local table, preserving `first_seen_at`.
 *
 * **Most sightings are partial, and this is called once per sighting.** Only
 * 313 of the 14,816 entities in the local database were ever fetched with a
 * `getEntity` of their own; the rest arrived nested inside somebody else's
 * traversal, trade row or search result, carrying whatever that endpoint chose
 * to include. A traversal terminal has its full `risk` block inline and no
 * `psa_count`; a search hit has neither.
 *
 * So **a column moves only when the incoming sighting actually states it.**
 * Anything else loses data in one of two directions, and both were measured
 * happening before this was written:
 *
 * - Writing every column on conflict **blanks** what a fuller sighting had
 *   established: 73 entities held `psaCount` — values 0 through 21 — and
 *   `relationshipCount` in their own stored payload while the row said null.
 * - Writing them only on insert **strands** a column null for ever after a
 *   first partial sighting, even once the entity's own payload arrives: 11
 *   entities had `sourceCount` stranded that way.
 *
 * `upstreamResponseId` names **the body this projection came out of**, and it
 * is optional because most entities have none of their own — the body that
 * carried them is that other company's, not theirs. Passing it only where it
 * is truly this entity's own payload is what keeps the Profile page's
 * provenance line honest — see the column's own note. It was the one column
 * already guarded this way; everything below generalises that note.
 */
export async function upsertEntity(
  db: Database,
  entity: SayariEntity,
  upstreamResponseId?: string | null,
): Promise<void> {
  const address = entity.attributes?.address?.data?.[0];
  const properties = address?.properties;
  const sourceCount = entity.source_count ?? null;
  const lei = findLei(entity);

  /**
   * What this sighting states, with `undefined` for everything it is silent
   * about. **`false` is a statement**, so a boolean is dropped only when the
   * payload omits the field entirely — not when it says `false`.
   *
   * `relationshipsTruncated` rides with `relationship_count` because it is
   * derived from it: without those counts it computes `0 > 0` and would report
   * a complete relationship set for a sighting that carried none.
   */
  const stated = {
    label: entity.label,
    entityType: entity.type ?? undefined,
    country: properties?.country ?? entity.countries?.[0] ?? undefined,
    addressLine: entity.addresses?.[0] ?? undefined,
    city: properties?.city ?? undefined,
    postcode: properties?.postcode ?? undefined,
    lat: properties?.y ?? undefined,
    lon: properties?.x ?? undefined,
    lei: lei ?? undefined,
    sourceCount: (sourceCount ?? undefined) as never,
    distinctSourceCount: sourceCount ? Object.keys(sourceCount).length : undefined,
    sanctioned: entity.sanctioned ?? undefined,
    pep: entity.pep ?? undefined,
    closed: entity.closed ?? undefined,
    risk: (entity.risk ?? undefined) as never,
    psaCount: entity.psa_count ?? undefined,
    ...(entity.relationship_count
      ? {
          relationshipCount: entity.relationship_count as never,
          relationshipsTruncated: relationshipsTruncated(entity),
        }
      : {}),
  };

  const said = Object.fromEntries(
    Object.entries(stated).filter(([, value]) => value !== undefined),
  ) as typeof stated;

  await db
    .insert(t.entity)
    .values({
      id: entity.id,
      // Only what was stated. The four booleans and `relationships_truncated`
      // are `not null default false`, so a sighting silent about them inserts
      // the column default rather than a claim it did not make.
      ...said,
      upstreamResponseId: upstreamResponseId ?? null,
      fetchedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: t.entity.id,
      set: {
        ...said,
        // Only when we have one. A nested sighting carries no body of this
        // entity's own, and letting it write null would erase the provenance a
        // direct fetch had already recorded.
        ...(upstreamResponseId ? { upstreamResponseId } : {}),
        fetchedAt: new Date(),
        // `firstSeenAt` is deliberately absent: the *new evidence* staleness
        // chip is computed from it, and re-stamping would silence the signal.
      },
    });
}

/**
 * `relationshipCount` is an **object keyed by relation type**, not a scalar.
 *
 * That object is what distinguishes *this company has no recorded owner* from
 * *we did not look far enough*, at zero cost.
 */
function relationshipsTruncated(entity: SayariEntity): boolean {
  const returned = entity.relationships?.data?.length ?? 0;
  const counts = entity.relationship_count ?? {};
  const total = Object.values(counts).reduce((sum, n) => sum + (typeof n === 'number' ? n : 0), 0);
  return total > returned;
}

/** Reads the batch pre-pass into per-row candidate id lists. */
export function prepassCandidateIds(resolution: {
  data?: { entity_id?: string; match_strength?: unknown }[] | null | undefined;
}): { entityId: string; matchStrength: string | undefined }[] {
  return (resolution.data ?? [])
    .filter((row): row is { entity_id: string; match_strength?: unknown } => Boolean(row.entity_id))
    .map((row) => ({
      entityId: row.entity_id,
      matchStrength: matchStrengthValue(row.match_strength as never),
    }));
}

export { eq };

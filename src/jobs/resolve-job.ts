import { eq } from 'drizzle-orm';
import * as t from '@/db/schema';
import type { Database } from '@/db/client';
import type { Upstream } from '@/upstream';
import { PREPASS_CANDIDATES } from '@/config/constants';
import { loadRoundCheckpoint, saveRoundCheckpoint } from './checkpoint';
import {
  prepassCandidateIds,
  resolveSupplier,
  type MatchLadder,
  type MatchLadderCheckpoint,
  type ResolveOutcome,
} from './resolve';
import { makeRunRound, type ResolveRoundDeps } from './resolve-round';

/**
 * The resolve Job, whole: rung R1 and then the agent Rounds.
 *
 * **Lifted out of the worker handler so the recorded path and the replayed path
 * are the same code.** A fixture captured from a script that re-created the
 * handler's setup by hand would prove only that the script works — the same
 * reason `runChatTurn` exists.
 *
 * ## R1 runs here and not inside `resolveSupplier`
 *
 * The batch pre-pass is **one call carrying every roster row** (SPEC §15.6), and
 * a function that resolves *one* Supplier is the wrong place to own a batch.
 * Passing its result in as `prepassEntityIds` is also what keeps each rung
 * honest about its cost: R1 is one call for the whole roster, and the Trace can
 * say so.
 */

export type ResolveJobDeps = {
  db: Database;
  upstream: Upstream;
  /** Absent in the deterministic tests, which exercise the gate and no model. */
  round?: ResolveRoundDeps | undefined;
  jobId?: string | undefined;
};

export async function runResolveJob(
  deps: ResolveJobDeps,
  args: { supplierId: string },
): Promise<ResolveOutcome> {
  const supplier = await deps.db.query.supplier.findFirst({
    where: eq(t.supplier.id, args.supplierId),
  });
  if (!supplier) throw new Error(`no supplier ${args.supplierId}`);
  if (!supplier.rosterName) throw new Error(`supplier ${args.supplierId} has no roster name`);

  // Rung R1. Address and country are omitted when the roster row lacks them,
  // rather than sent as nulls — an empty field is a different query.
  const prepass = await deps.upstream.sayari.resolve({
    body: {
      name: [supplier.rosterName],
      ...(supplier.rosterAddress ? { address: [supplier.rosterAddress] } : {}),
      ...(supplier.rosterCountry ? { country: [supplier.rosterCountry] } : {}),
    },
  });

  return resolveSupplier(
    {
      db: deps.db,
      upstream: deps.upstream,
      /**
       * Without a round runner the ladder stops at the auto-accept gate and
       * parks every row it cannot settle by rules. That is a legitimate state —
       * and the wrong one for a worker, which exists to spend tokens on exactly
       * the rows rules could not settle.
       */
      ...(deps.round ? { runRound: makeRunRound(deps.round) } : {}),
      /**
       * The Round boundary is the resume point, and it is assembled here rather
       * than inside the ladder for the same reason `runRound` is: the ladder
       * stays runnable with no Job and no database, which is what the
       * deterministic Discriminator tests depend on.
       */
      ...(deps.jobId ? { checkpoint: matchLadderCheckpoint(deps.db, deps.jobId) } : {}),
    },
    {
      supplierId: supplier.id,
      roster: {
        name: supplier.rosterName,
        address: supplier.rosterAddress,
        country: supplier.rosterCountry,
        hasCategory: true,
      },
      prepassEntityIds: prepassCandidateIds(prepass.data)
        .slice(0, PREPASS_CANDIDATES)
        .map((candidate) => candidate.entityId),
      jobId: deps.jobId,
    },
  );
}

/**
 * The Match ladder's checkpoint, bound to one Job.
 *
 * The stored shape is the ladder's own (`MatchLadder`): the rungs it has
 * climbed, the objection the next Round has to answer, and every Candidate it
 * has seen with the rung that found it. Re-projecting the Candidates from their
 * cached entity bodies is what keeps this from being a second copy of a payload
 * the database already holds once.
 */
function matchLadderCheckpoint(db: Database, jobId: string): MatchLadderCheckpoint {
  return {
    load: async () => {
      const stored = await loadRoundCheckpoint<MatchLadder>(db, jobId);
      return stored ? { roundN: stored.n, ladder: stored.checkpoint } : undefined;
    },
    save: (roundN, ladder) => saveRoundCheckpoint(db, jobId, roundN, ladder),
  };
}

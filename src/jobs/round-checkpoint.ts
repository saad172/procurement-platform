import type { Database } from '@/db/client';
import { loadRoundCheckpoint, saveRoundCheckpoint } from './checkpoint';
import type { LoopCheckpoint, RoundState } from './rounds';

/**
 * The proposer/evaluator ladder's checkpoint, bound to one Job.
 *
 * It is a two-line adapter rather than a dependency of `rounds.ts` because the
 * ladder is written to be runnable with no database at all — that is what lets
 * `runs.test.ts` prove `rejected_by_code` and the free-retry budget without a
 * model or a Job — and a ladder that imported a table would have taken that
 * away for the sake of removing four lines.
 *
 * `RoundState` is JSON all the way down: a draft is what a `submit_*` tool
 * carried, objections are strings, and a Round record is the row that will be
 * written when the version publishes. So the checkpoint is the state, not a
 * projection of it, and a resumed ladder cannot be missing part of what it was
 * arguing about.
 */
export function roundCheckpoint<TDraft>(db: Database, jobId: string): LoopCheckpoint<TDraft> {
  return {
    load: async () => {
      const stored = await loadRoundCheckpoint<RoundState<TDraft>>(db, jobId);
      return stored ? { roundN: stored.n, state: stored.checkpoint } : undefined;
    },
    save: (roundN, state) => saveRoundCheckpoint(db, jobId, roundN, state),
  };
}

import type { Database } from '@/db/client';
import { loadParkedRow } from '@/db/queries/needs-review';
import { settleAnswer, settleChoices } from '@/domain/settle-choices';

/**
 * Everything this page renders, in one read (SPEC §13.1).
 *
 * A page reads through `db/queries`, never through the schema — see
 * `supplier-page.ts` for why.
 */
export async function loadSettlePage(
  db: Database,
  args: { programId: string, supplierId: string; query: Record<string, string | string[] | undefined> },
) {
  const { programId, supplierId, query } = args;

  const row = await loadParkedRow(db, { programId, supplierId });
  if (!row) return undefined;

  const { supplier, match, candidates, attempts, programName } = row;
  const answer = settleAnswer({ rosterName: supplier.rosterName ?? '', candidates });
  const { shared, groups } = settleChoices({
    rosterName: supplier.rosterName ?? '',
    candidates,
  });

  const error = typeof query.error === 'string' ? query.error : undefined;
  const settled = typeof query.settled === 'string' ? query.settled : undefined;
  const done = match.status === 'accepted' || match.settledBy === 'human';

  return {
    answer,
    error,
    settled,
    done,
    supplier,
    match,
    attempts,
    programName,
    shared,
    groups,
  };
}

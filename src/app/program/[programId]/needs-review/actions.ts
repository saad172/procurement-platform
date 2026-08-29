'use server';

import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { getPooledDb } from '@/db/client';
import * as t from '@/db/schema';
import { enqueueJob, openRun } from '@/jobs/runs';
import { settleMatch } from '@/domain/match/settle-match';

/**
 * Settling a Match by hand (SPEC §6.8, §12 D21).
 *
 * A person picks a Candidate, enters a Sayari entity id, or marks the row
 * not-found — with an optional note stored as a `round` with `role='human'`.
 *
 * **The settlement writes a NEW `match_attempt`**, so an override after an
 * agent accept shows *both* settlements rather than one erasing the other. That
 * is why the table is append-only.
 *
 * And it **starts a new Run** (SPEC §22 Q4). A settled row unblocks enrichment
 * and assessment, and that spend has to belong somewhere: charging it to the
 * original run would move a total somebody has already read, so *"every amount
 * spent sits inside some run, with no orphan path"* is bought at the
 * knowingly-accepted cost of a longer Runs list.
 */
export async function settleByHand(formData: FormData): Promise<void> {
  const supplierId = String(formData.get('supplierId'));
  const entityId = String(formData.get('entityId') ?? '').trim();
  const note = String(formData.get('note') ?? '').trim();
  const programId = String(formData.get('programId'));

  const db = getPooledDb();
  const supplier = await db.query.supplier.findFirst({ where: eq(t.supplier.id, supplierId) });
  if (!supplier) return;

  await settleMatch(db, {
    supplierId,
    status: entityId ? 'accepted' : 'not_found',
    entityId: entityId || null,
    settledBy: 'human',
    note: note || undefined,
  });

  // A new Run, subject-labelled, so the spend it unblocks is attributable to
  // this decision rather than to the run that could not settle it.
  const runId = await openRun(db, {
    programId,
    trigger: 'settlement',
    subjectLabel: `settle ${supplier.rosterName ?? supplierId}`,
    supplierCount: 1,
  });
  if (entityId) {
    await enqueueJob(db, { runId, kind: 'enrich', subjectType: 'supplier', subjectId: supplierId });
  }

  revalidatePath(`/program/${programId}/needs-review`);
  revalidatePath(`/program/${programId}`);
}

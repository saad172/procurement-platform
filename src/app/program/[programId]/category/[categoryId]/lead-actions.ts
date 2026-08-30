'use server';

import { revalidatePath } from 'next/cache';
import { getPooledDb } from '@/db/client';
import { dismissLead, promoteLead } from '@/jobs/promote-lead';
import { enqueueJob, openRun } from '@/jobs/runs';

/**
 * Promoting and dismissing are **UI-only** (SPEC §15.6).
 *
 * Neither is a tool, on any surface, because neither is a Job: they are **a
 * person's judgement recorded**. Chat can propose a Discover run; it cannot
 * promote what that run found.
 */
export async function promote(formData: FormData): Promise<void> {
  const db = getPooledDb();
  const leadId = String(formData.get('leadId'));
  const programId = String(formData.get('programId'));
  const categoryId = String(formData.get('categoryId'));

  const { supplierId } = await promoteLead(db, {
    leadId,
    confirmedCategoryIds: formData.getAll('categoryIds').map(String).filter(Boolean),
  });

  // A promoted Lead needs enriching before it can be scored, and that spend
  // starts a Run of its own so it is attributable to this decision.
  const runId = await openRun(db, {
    programId,
    trigger: 'settlement',
    subjectLabel: 'promote a discovered lead',
    supplierCount: 1,
  });
  await enqueueJob(db, { runId, kind: 'enrich', subjectType: 'supplier', subjectId: supplierId });

  revalidatePath(`/program/${programId}/category/${categoryId}`);
}

export async function dismiss(formData: FormData): Promise<void> {
  const db = getPooledDb();
  await dismissLead(db, String(formData.get('leadId')), formData.get('undo') !== 'true');
  revalidatePath(
    `/program/${String(formData.get('programId'))}/category/${String(formData.get('categoryId'))}`,
  );
}

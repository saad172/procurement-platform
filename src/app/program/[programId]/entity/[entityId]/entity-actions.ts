'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { getPooledDb } from '@/db/client';
import * as t from '@/db/schema';
import { enqueueJob, openRun } from '@/jobs/runs';

/**
 * **Fetch one company's own record**, because a person asked for it.
 *
 * Most entities have no payload of their own: they arrived nested inside
 * somebody else's traversal or search result, so their attributes are copied
 * out of another company's response and their relationships were never read.
 * Of 14,491 stored entities, 288 had a record of their own.
 *
 * ## Why this is a button and not automatic
 *
 * The first design queued a fetch the moment a nested company was seen. It
 * worked — one Supplier's re-enrich queued fifteen — and then the count was
 * measured against the whole database: **4,448 companies** have no record of
 * their own and are reachable as an edge target. That is about seven times
 * every Sayari call this project has made to date, spent mostly on companies
 * nobody will ever open.
 *
 * Nothing in the app would have stopped it either. A Run's budget prices model
 * tokens only, so upstream spend contributes zero to it, and the per-Job
 * ceiling bounds each fetch at two calls without bounding how many Jobs there
 * are.
 *
 * So the trigger is a person, and the cost is one call for the one company they
 * are looking at. The Job, its ceiling and its handler are unchanged — only
 * what starts it.
 */
export async function fetchOwnRecord(formData: FormData): Promise<void> {
  const programId = String(formData.get('programId'));
  const entityId = String(formData.get('entityId'));

  const db = getPooledDb();
  const entity = await db.query.entity.findFirst({ where: eq(t.entity.id, entityId) });
  if (!entity) return;

  // Already has one: the button is not rendered, and a resubmitted form should
  // not spend a credit to fetch what is already stored.
  if (entity.upstreamResponseId) {
    revalidatePath(`/program/${programId}/entity/${entityId}`);
    return;
  }

  const runId = await openRun(db, {
    programId,
    trigger: 'fetch_record',
    subjectLabel: `fetch the record for ${entity.label}`,
    supplierCount: 1,
  });
  await enqueueJob(db, { runId, kind: 'fetch_entity', subjectType: 'entity', subjectId: entityId });

  revalidatePath(`/program/${programId}/entity/${entityId}`);
  redirect(`/program/${programId}/runs/${runId}` as never);
}

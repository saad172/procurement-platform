import { eq } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as t from '@/db/schema';
import { enqueueJob, openRun } from '@/jobs/runs';
import { candidatesSeen, settleMatch } from '@/domain/match/settle-match';
import { parseSettlement } from '@/domain/settle-request';

/**
 * Settling a Match by hand (SPEC §6.8, §12 D21).
 *
 * This is the whole decision, kept **out of the `'use server'` module** so it
 * can be run by a test rather than only by a browser. The action there is a
 * wrapper that redirects on the result; everything that can be got wrong is
 * here.
 *
 * A person picks one of the Candidates the page listed, marks the row not
 * found, or — for a record they found in Sayari's own interface that no rung
 * surfaced — types an id, which is **checked against the entity store before
 * anything is written**.
 *
 * That check is the change. The form used to take whatever was in a free-text
 * box and pass it to `settleMatch` unread. A foreign key and a transaction
 * stopped bad data reaching the database, so the failure was never corruption —
 * but it arrived as an **unhandled error with no message**: a 500 on a page
 * that carried one form per parked row, which does not say which row threw or
 * what was wrong with it. Every refusal now comes back as a sentence.
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

export type SettleOutcome =
  | { ok: true; settled: 'accepted' | 'not_found'; runId: string }
  | { ok: false; error: string };

export async function settleRowByHand(
  db: Database,
  args: { fields: { get(name: string): unknown }; supplierId: string; programId: string },
): Promise<SettleOutcome> {
  const { fields, supplierId, programId } = args;

  const supplier = await db.query.supplier.findFirst({ where: eq(t.supplier.id, supplierId) });
  if (!supplier || supplier.programId !== programId) {
    return { ok: false, error: 'That roster row is not in this program, so nothing was written.' };
  }

  // What this row's page actually offered, read back rather than trusted from
  // the form: a hand-made POST names whatever it likes.
  const candidateIds = await candidatesSeen(db, supplierId);
  const parsed = parseSettlement(fields, { candidateIds });
  if (!parsed.ok) return parsed;

  if (parsed.kind === 'typed') {
    const known = await db.query.entity.findFirst({ where: eq(t.entity.id, parsed.entityId) });
    if (!known) {
      return {
        ok: false,
        error: `${parsed.entityId} is not a record this app has fetched, so nothing was written. Only entities already in the store can be settled on — search for the company first, so its record is here to point at.`,
      };
    }
  }

  const entityId = parsed.kind === 'not_found' ? null : parsed.entityId;

  await settleMatch(db, {
    supplierId,
    status: entityId ? 'accepted' : 'not_found',
    entityId,
    settledBy: 'human',
    note: parsed.note,
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

  return { ok: true, settled: entityId ? 'accepted' : 'not_found', runId };
}

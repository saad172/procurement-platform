'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getPooledDb } from '@/db/client';
import { settleRowByHand } from '@/jobs/settle-by-hand';

/**
 * The form seam for settling a Match by hand (SPEC §6.8).
 *
 * Deliberately thin. Everything that can be got wrong — what the form is
 * allowed to name, whether a typed id exists, which Run the unblocked spend
 * belongs to — is in `settleRowByHand`, which is an ordinary module a test can
 * import. Testing it through this file would mean testing it through a browser.
 *
 * What is left here is the two things only a request can do: revalidate the
 * pages the settlement changed, and put the reader back on the row carrying
 * either the outcome or the reason nothing was written.
 */
export async function settleByHand(formData: FormData): Promise<void> {
  const supplierId = String(formData.get('supplierId') ?? '');
  const programId = String(formData.get('programId') ?? '');

  const outcome = await settleRowByHand(getPooledDb(), {
    fields: formData,
    supplierId,
    programId,
  });

  if (outcome.ok) {
    revalidatePath(`/program/${programId}/needs-review`);
    revalidatePath(`/program/${programId}/needs-review/${supplierId}`);
    revalidatePath(`/program/${programId}`);
  }

  // Outside any try, and after every await: `redirect` works by throwing.
  const here = `/program/${programId}/needs-review/${supplierId}`;
  const back = outcome.ok
    ? `${here}?settled=${outcome.settled}`
    : `${here}?error=${encodeURIComponent(outcome.error)}`;
  redirect(back as never);
}

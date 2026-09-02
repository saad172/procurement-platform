'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getPooledDb } from '@/db/client';
import { setRecommendationMark, type MarkRequest } from '@/jobs/mark-recommendation';

/**
 * The form seam for the human mark on a Recommendation (CONTEXT.md:
 * *Versioned; a person marks it accepted, rejected or needs work*).
 *
 * Deliberately thin, like `needs-review/actions.ts`. Everything that can be got
 * wrong — whether the ids are ids, whether the version belongs to the Category
 * whose page sent it, and clearing the accepted sibling in one transaction —
 * is in `jobs/mark-recommendation.ts`, which is an ordinary module a test can
 * import. Testing it through this file would mean testing it through a browser.
 *
 * What is left here is the two things only a request can do: revalidate the
 * pages the mark changed, and put the reader back on the version they marked
 * carrying either the mark or the reason nothing was written.
 *
 * **These are the only writers of `human_mark`.** No tool exposes a mark on any
 * surface, for the reason promotion and dismissal are UI-only (SPEC §15.6):
 * neither is a Job, both are a person's judgement recorded, and an agent that
 * could accept a Recommendation could accept its own.
 *
 * The request arrives as a bound argument rather than as hidden inputs because
 * a mark has no field a person types — it is three ids the page just read and
 * one word from a closed set. The action re-reads all four before writing
 * anything, so the binding is a convenience and never the check.
 */

/** Accept, reject, or say a Recommendation version needs work. */
export async function markRecommendationVersion(request: MarkRequest): Promise<void> {
  await write(request);
}

/** Take a mark back. The version is unmarked again, not marked something else. */
export async function clearRecommendationMark(request: Omit<MarkRequest, 'mark'>): Promise<void> {
  await write({ ...request, mark: null });
}

async function write(request: MarkRequest): Promise<never> {
  const { programId, categoryId } = request;
  const outcome = await setRecommendationMark(getPooledDb(), request);

  const here = `/program/${programId}/category/${categoryId}/recommendation`;

  if (outcome.ok) {
    revalidatePath(here);
    // The Category page carries the same version and the same mark in its
    // "argued case" card, so a mark that showed on one page and not the other
    // would be two answers to one question.
    revalidatePath(`/program/${programId}/category/${categoryId}`);
  }

  // Outside any try, and after every await: `redirect` works by throwing.
  // The reader lands on the version they acted on, whether or not the rule
  // would have shown it — accepting the newer sibling is the one case where
  // the act and the page's default disagree until the write lands.
  const back = outcome.ok
    ? `${here}?version=${outcome.versionN}`
    : `${here}?markError=${encodeURIComponent(outcome.error)}`;
  redirect(back as never);
}

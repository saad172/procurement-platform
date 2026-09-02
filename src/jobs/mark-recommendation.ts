import { and, eq, ne } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as t from '@/db/schema';
import { isDatabaseId } from '@/tools/ids';
import type { RecommendationMark } from '@/domain/recommendation-mark';

/**
 * Marking a Recommendation version by hand (CONTEXT.md: *Versioned; a person
 * marks it accepted, rejected or needs work*).
 *
 * This is the whole decision, kept **out of the `'use server'` module** so a
 * test can run it rather than only a browser — the same split as
 * `settle-by-hand.ts`, and for the same reason. It lives beside that file
 * because this directory is where a write lives, whether a Job or a person
 * makes it; what makes a mark a *person's* act is not its folder but that
 * **nothing calls this except the action a click reaches**. Every version a Job
 * creates is born unmarked: `publishVersion` writes `human_mark: null`
 * explicitly, so an agent cannot accept its own argument.
 *
 * **The mark writes one column pair and nothing else.** Sentences, Picks,
 * Citations, Rounds and the version's `evaluator_outcome` are all left exactly
 * as published — a person's judgement about a document is not an edit to it.
 *
 * **Accepting clears the sibling** (SPEC §12.5). The page shows the most recent
 * accepted version, so two accepted versions of one Recommendation would make
 * *the accepted one* ambiguous. The clear and the write happen in one
 * transaction, under a partial unique index that refuses the state anyway.
 *
 * Only an `accepted` sibling is cleared. *Rejected* and *needs work* are notes
 * a person may leave on as many versions as they read, and clearing them would
 * be this action editing a judgement it was not asked about.
 */

export type MarkRequest = {
  programId: string;
  categoryId: string;
  versionId: string;
  /** `null` clears the mark: a person may take back what they said. */
  mark: RecommendationMark | null;
};

export type MarkOutcome =
  | {
      ok: true;
      versionN: number;
      mark: RecommendationMark | null;
      /** The version numbers whose acceptance this act cleared, for the notice. */
      clearedFrom: number[];
    }
  | { ok: false; error: string };

export async function setRecommendationMark(
  db: Database,
  request: MarkRequest,
): Promise<MarkOutcome> {
  const { programId, categoryId, versionId, mark } = request;

  // Checked before the query, because Postgres answers a non-uuid with a thrown
  // type error rather than an empty result — and an action reachable by POST
  // is reachable with any string at all.
  if (!isDatabaseId(programId) || !isDatabaseId(categoryId) || !isDatabaseId(versionId)) {
    return {
      ok: false,
      error: 'That is not a recommendation version id, so nothing was written.',
    };
  }

  const version = await db.query.recommendationVersion.findFirst({
    where: eq(t.recommendationVersion.id, versionId),
    with: { recommendation: true },
  });
  if (!version) {
    return { ok: false, error: 'That version no longer exists, so nothing was written.' };
  }

  /**
   * The version is read back and checked against the Category whose page sent
   * it, rather than trusted from the request: a form is a reference to a row,
   * never the row's contents, and a hand-made POST names whatever it likes.
   */
  if (
    version.recommendation.programId !== programId ||
    version.recommendation.categoryId !== categoryId
  ) {
    return {
      ok: false,
      error:
        'That version belongs to a different category’s recommendation, so nothing was written.',
    };
  }

  const markedAt = new Date();

  const clearedFrom = await db.transaction(async (tx) => {
    let cleared: { n: number }[] = [];

    if (mark === 'accepted') {
      cleared = await tx
        .update(t.recommendationVersion)
        .set({ humanMark: null, humanMarkedAt: null })
        .where(
          and(
            eq(t.recommendationVersion.recommendationId, version.recommendationId),
            eq(t.recommendationVersion.humanMark, 'accepted'),
            ne(t.recommendationVersion.id, versionId),
          ),
        )
        .returning({ n: t.recommendationVersion.n });
    }

    await tx
      .update(t.recommendationVersion)
      // The moment goes with the mark: clearing one clears the other, so a
      // version never carries a date for a decision it no longer holds.
      .set({ humanMark: mark, humanMarkedAt: mark ? markedAt : null })
      .where(eq(t.recommendationVersion.id, versionId));

    return cleared.map((row) => row.n);
  });

  return { ok: true, versionN: version.n, mark, clearedFrom };
}

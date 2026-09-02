import type * as t from '@/db/schema';

/**
 * The human mark on a Recommendation version, and the words it is said in.
 *
 * CONTEXT.md's Recommendation entry ends *"Versioned; a person marks it
 * accepted, rejected or needs work"* — three words, and this file is where they
 * are turned into sentences so that the Recommendation page's header, the
 * Category page's *argued case* card and the Category answer all say the same
 * thing. Three renderers of one fact is how a sentence drifts (finding 105).
 *
 * **A mark records a person's act and is an input to nothing.** It moves no
 * Score, edits no sentence, adds and removes no Pick, touches no Citation, and
 * never rewrites the version's `evaluator_outcome`: a second read agreeing with
 * the author and a buyer accepting the argument are two different facts about
 * one version, and the header shows them side by side rather than folding one
 * into the other.
 *
 * **The who is always "a person".** Authentication is a stated non-goal (SPEC
 * §1.2), so the app knows an act was a human's and cannot know whose — naming
 * one would be inventing it, which is the failure this whole build is against.
 */
export type RecommendationMark = NonNullable<
  (typeof t.recommendationVersion.$inferSelect)['humanMark']
>;

/**
 * The three marks, in the order the controls offer them: the two that settle a
 * version first, then the one that asks for another.
 */
export const RECOMMENDATION_MARKS = [
  'accepted',
  'rejected',
  'needs_work',
] as const satisfies readonly RecommendationMark[];

/** The mark as CONTEXT says it: `needs_work` is *needs work* wherever it is shown. */
export function markWord(mark: RecommendationMark): string {
  return mark.replace(/_/g, ' ');
}

/**
 * The label on the button that sets a mark — an imperative, because a button is
 * something a person does and the badge beside it is already the noun.
 */
export const MARK_BUTTON_LABEL: Record<RecommendationMark, string> = {
  accepted: 'Accept',
  rejected: 'Reject',
  needs_work: 'Needs work',
};

/** The badge class each mark carries, from `globals.css`'s four tones. */
export function markTone(mark: RecommendationMark | null): 'good' | 'bad' | 'warn' | 'mute' {
  if (mark === 'accepted') return 'good';
  if (mark === 'rejected') return 'bad';
  if (mark === 'needs_work') return 'warn';
  return 'mute';
}

export type MarkHeader = {
  /** The badge's text. An unmarked version says so rather than showing nothing. */
  badge: string;
  tone: 'good' | 'bad' | 'warn' | 'mute';
  /** Who marked it and when, then what the mark does and does not do. */
  line: string;
};

/**
 * The header line: **what a person decided about this version, and when.**
 *
 * Each mark's second sentence is the one thing a reader could otherwise get
 * wrong about it — that acceptance survives a re-run (SPEC §12.5), that a
 * rejection leaves the document exactly as published, and that *needs work*
 * writes no version because a re-run does (SPEC §10.6).
 */
export function markHeader(input: {
  mark: RecommendationMark | null;
  markedAt: Date | null;
  versionN: number;
}): MarkHeader {
  const { mark, markedAt, versionN } = input;
  // `YYYY-MM-DD`, as every other date this app renders: a locale-formatted date
  // reads differently on the server and in the browser, and a mark is dated
  // evidence about a decision rather than decoration.
  const on = markedAt ? ` on ${markedAt.toISOString().slice(0, 10)}` : '';

  if (!mark) {
    return {
      badge: 'unmarked',
      tone: 'mute',
      line:
        `Nobody has marked version ${versionN}. ` +
        'A recommendation is versioned, and a person marks it accepted, rejected or needs work — ' +
        'the reviewer agreeing with the author is not the same act.',
    };
  }

  if (mark === 'accepted') {
    return {
      badge: 'accepted by a person',
      tone: 'good',
      line:
        `A person accepted version ${versionN}${on}. ` +
        'Acceptance never moves: a re-run writes a new version and never clears this mark, ' +
        'so this page keeps showing what was accepted until somebody accepts something else.',
    };
  }

  if (mark === 'rejected') {
    return {
      badge: 'rejected by a person',
      tone: 'bad',
      line:
        `A person rejected version ${versionN}${on}. ` +
        'The version stands exactly as it was published — a mark changes no sentence, no pick and ' +
        'no citation — and the rejection is the record that nobody acted on it.',
    };
  }

  return {
    badge: 'needs work, said by a person',
    tone: 'warn',
    line:
      `A person marked version ${versionN} needs work${on}. ` +
      'Needs work writes no version; a re-run does, and that is a separate click that spends — ' +
      'so this stands as the request until somebody makes it.',
  };
}

/** A strip above the argument: what a reader is looking at, and why that one. */
export type VersionStrip = { said: string; because: string };

/**
 * The strip naming a newer sibling (SPEC §12.5).
 *
 * A page showing an accepted version while a newer one exists has to say so, or
 * it is quietly hiding the most recent argument. It names the count rather than
 * the newest alone, because *"two versions have been written since you accepted
 * this"* is different news from *"one has"*.
 */
export function newerVersionStrip(input: {
  shownN: number;
  latestN: number;
  newer: number;
}): VersionStrip {
  const { shownN, latestN, newer } = input;
  return {
    said:
      newer === 1
        ? `A newer version exists: version ${latestN} was written after version ${shownN} was accepted.`
        : `${newer} newer versions exist, the most recent being version ${latestN}, all written after version ${shownN} was accepted.`,
    because:
      'Acceptance never moves: a re-run always writes a new version and never clears an accepted ' +
      `mark, so this page keeps showing version ${shownN} — the argument somebody signed off on — ` +
      'rather than swapping it for one nobody has read.',
  };
}

/**
 * The strip for a version a reader asked for by number.
 *
 * Reading a version the rule would not have shown is a legitimate act — it is
 * how the newer sibling gets read at all — but the page has to say that this is
 * not what it shows by default, or the reader cannot tell an accepted argument
 * from an unread one.
 */
export function pinnedVersionStrip(input: {
  viewingN: number;
  defaultN: number;
  defaultMark: RecommendationMark | null;
}): VersionStrip {
  const { viewingN, defaultN, defaultMark } = input;
  return {
    said: `You are reading version ${viewingN}, which is not the version this page shows by default.`,
    because:
      defaultMark === 'accepted'
        ? `Version ${defaultN} is the one a person accepted, and acceptance never moves — accepting ` +
          `version ${viewingN} is what would put it in front, and it clears the acceptance from version ${defaultN}.`
        : `Version ${defaultN} is the latest, and the latest is what this page shows when nobody has ` +
          'accepted anything.',
  };
}

/**
 * The note beside the controls.
 *
 * The reason sits next to the buttons rather than in a tooltip because the
 * thing a reader most needs to know before clicking is what the click does
 * *not* do: nothing here re-runs anything, and nothing here spends.
 */
export const MARK_CONTROL_NOTE =
  'A mark is your act and is an input to nothing: it moves no score, edits no sentence, adds no ' +
  'pick and never rewrites the reviewer’s outcome. Nothing here spends — re-running is a separate ' +
  'control, and it writes a new version rather than changing this one.';

/** The note under Accept, which is the one control with a consequence elsewhere. */
export const ACCEPT_CONTROL_NOTE =
  'Only one version can be accepted at a time, so accepting this one clears the acceptance from ' +
  'whichever version holds it. This page then shows the accepted version rather than the latest.';

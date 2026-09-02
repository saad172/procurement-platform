/**
 * What a Category page says before anything else.
 *
 * **This is the page the product exists to produce**, and it rendered
 * "Actions", "Tariff" and "Weights" — three pieces of apparatus — before the
 * Shortlist. A buyer opening it wants to know who is in front, whether that is
 * a real lead, and whether anybody has argued for awarding to them; all three
 * were reachable only by scrolling past the machinery that produced them.
 *
 * Unlike a Supplier's, a Category's answer is **two things**, and they are two
 * because they can be true at once and are not the same news:
 *
 * 1. Who leads, and whether the lead means anything.
 * 2. Whether anybody has written a recommendation — because **a ranking is not
 *    a decision**, and a page showing a confident order with no argued case
 *    behind it invites being read as one.
 */

import type { AnswerTone } from './supplier-answer';
import { markWord, type RecommendationMark } from './recommendation-mark';

export type CategoryAnswer = {
  tone: AnswerTone;
  said: string;
  because: string;
  actions: { label: string; href?: string; action?: 'recommend'; primary?: boolean }[];
};

export type CategoryAnswerInput = {
  categoryName: string;
  /** Ranked, best first, as the Shortlist ranked them. Unfiltered. */
  ranked: {
    supplierId: string;
    displayName: string;
    score: number | null;
    coverage: { computed: number; total: number };
    disqualifying: boolean;
  }[];
  /** Rows that reach no ranking, and why. */
  excluded: { reason: 'no_match' | 'no_category' }[];
  /** The published recommendation for this category, when there is one. */
  recommendation:
    | {
        versionN: number;
        evaluatorOutcome: 'passed' | 'published_with_objections';
        /** What a person decided about it, if anybody has decided anything. */
        humanMark: RecommendationMark | null;
      }
    | undefined;
  recommendationHref: string;
  compareHref: string | null;
  supplierHref: (supplierId: string) => string;
};

/**
 * A gap this size or smaller is **inside what moving a weight does**.
 *
 * Not a statistical claim and not presented as one: it is a stated threshold
 * for when the page stops calling a first place settled. The weight rail is one
 * drag away on the same screen, and a lead a reader can overturn by using the
 * control next to it is a lead worth saying is narrow.
 */
const NARROW_LEAD = 2;

export function categoryAnswer(input: CategoryAnswerInput): CategoryAnswer[] {
  return [leadAnswer(input), recommendationAnswer(input)].filter(
    (answer): answer is CategoryAnswer => answer != null,
  );
}

function leadAnswer(input: CategoryAnswerInput): CategoryAnswer | null {
  const { categoryName, ranked } = input;
  const scored = ranked.filter((row) => row.score != null);

  if (scored.length === 0) {
    const excluded = input.excluded.length;
    return {
      tone: 'neutral',
      said: `Nothing on ${categoryName} can be ranked yet.`,
      because:
        excluded > 0
          ? `${excluded} ${excluded === 1 ? 'supplier bids' : 'suppliers bid'} on this category and none of them has a score. A score needs a settled identity and at least one thing measured about the company; until both exist there is nothing to put in order.`
          : 'No supplier bids on this category in this program, so there is nobody to rank. Suppliers reach a category through the roster mapping, and companies found by searching reach it as leads.',
      actions: [],
    };
  }

  const [first, second] = scored;
  const leader = first!;

  if (leader.disqualifying) {
    return {
      tone: 'stop',
      said: `${leader.displayName} tops ${categoryName} and carries something that rules it out.`,
      because:
        'It ranks first on the weighted score and a disqualifying factor fired against it, which is a different kind of fact from a low number — the score says how well it fits, and this says whether it can be considered at all.',
      actions: [
        { label: `Read what fired`, href: input.supplierHref(leader.supplierId), primary: true },
      ],
    };
  }

  if (!second || second.score == null) {
    return {
      tone: 'ok',
      said: `${leader.displayName} leads ${categoryName}, and it is the only supplier with a score.`,
      because: `Nothing else on this category has enough measured to rank, so ${leader.displayName} is first by default rather than by comparison. One scored bidder is a shortlist of one, which is a weaker thing than it looks.`,
      actions: [
        { label: `Open ${leader.displayName}`, href: input.supplierHref(leader.supplierId) },
      ],
    };
  }

  const gap = leader.score! - second.score;
  const narrow = gap <= NARROW_LEAD;
  const compare = input.compareHref
    ? [{ label: 'Compare the top two side by side', href: input.compareHref, primary: narrow }]
    : [];

  /**
   * **The gap that matters is often not the score.** Two suppliers a point
   * apart can differ far more in how much has actually been measured about
   * them, and a reader given only the scores would never see it.
   */
  const coverageGap = leader.coverage.computed - second.coverage.computed;

  return {
    tone: narrow ? 'you' : 'ok',
    said: narrow
      ? `${leader.displayName} leads ${categoryName} — but by ${format(gap)}, which is not a settled first place.`
      : `${leader.displayName} leads ${categoryName}, comfortably.`,
    because: [
      `${leader.displayName} scores ${format(leader.score!)} and ${second.displayName} ${format(second.score)}.`,
      narrow
        ? 'A gap that small is well inside what changes when you move a weight, and the weight rail is on this page.'
        : `That is ${format(gap)} between them, which no single weight on this page will close.`,
      coverageGap < 0
        ? `And the leader rests on less: ${leader.coverage.computed} of ${leader.coverage.total} criteria returned a value against ${second.displayName}'s ${second.coverage.computed}. A higher score over fewer measurements is not the same claim.`
        : coverageGap > 0
          ? `Both are measured on what we have — ${leader.coverage.computed} of ${leader.coverage.total} criteria for the leader, ${second.coverage.computed} for the runner-up.`
          : `Both rest on the same ${leader.coverage.computed} of ${leader.coverage.total} criteria, so the comparison is like for like.`,
    ].join(' '),
    actions: [
      ...compare,
      { label: `Open ${leader.displayName}`, href: input.supplierHref(leader.supplierId) },
    ],
  };
}

function recommendationAnswer(input: CategoryAnswerInput): CategoryAnswer | null {
  // Nothing to recommend from, and the first answer already said so.
  if (input.ranked.every((row) => row.score == null)) return null;

  if (!input.recommendation) {
    return {
      tone: 'stop',
      said: 'Nobody has written a recommendation for this category.',
      because:
        'There is a ranking here but no argued case for awarding to anybody — and a ranking is not a decision. A recommendation runs against the unfiltered shortlist, names picks with roles, and cites what each rests on.',
      actions: [{ label: 'Write one', action: 'recommend', primary: true }],
    };
  }

  /**
   * **A person's mark outranks the reviewer's outcome**, because it is the
   * later act and the one a buyer is accountable for. A page that led with
   * *"a second read agreed with it"* over a rejection would be reporting the
   * agent's opinion of a document a human has already turned down.
   */
  if (input.recommendation.humanMark) {
    return markedAnswer(input, input.recommendation.humanMark);
  }

  if (input.recommendation.evaluatorOutcome === 'published_with_objections') {
    return {
      tone: 'you',
      said: 'The recommendation for this category was published over an objection.',
      because:
        'The reviewer disagreed with the author and neither backed down, so it stands as written with the disagreement attached rather than resolved. Nobody has signed off on it.',
      actions: [
        { label: 'Read the recommendation', href: input.recommendationHref, primary: true },
      ],
    };
  }

  return {
    tone: 'ok',
    said: `There is a recommendation for ${input.categoryName}, and a second read agreed with it.`,
    because:
      'It names who to award to and who to hold as a second source, argued against the unfiltered shortlist, with every sentence cited to what it rests on.',
    actions: [{ label: 'Read the recommendation', href: input.recommendationHref }],
  };
}

/**
 * What a person's mark says about a Category, in CONTEXT's own words.
 *
 * The three read differently on purpose. *Accepted* is the only one that closes
 * the question, so it is the only one that reads `ok`; *rejected* and *needs
 * work* both leave a Category with a ranking and no decision, which is
 * something waiting on a person. None of them touches the argument itself — the
 * conditions and open questions are still the version's to state.
 */
function markedAnswer(input: CategoryAnswerInput, mark: RecommendationMark): CategoryAnswer {
  const read = { label: 'Read the recommendation', href: input.recommendationHref };

  if (mark === 'accepted') {
    return {
      tone: 'ok',
      said: `A person accepted the recommendation for ${input.categoryName}.`,
      because:
        'It names who to award to and who to hold as a second source, and somebody signed off on ' +
        'it. A re-run would write a new version and would not clear that acceptance, so this stays ' +
        'the answer until a person marks another version instead.',
      actions: [{ ...read, primary: true }],
    };
  }

  if (mark === 'rejected') {
    return {
      tone: 'you',
      said: `A person rejected the recommendation for ${input.categoryName}.`,
      because:
        'The version stands exactly as published — a mark edits no sentence and removes no pick — ' +
        'but nobody is acting on it, so this category has a ranking and no decision behind it. ' +
        'Re-running writes a new version to argue the case differently.',
      actions: [{ ...read, primary: true }],
    };
  }

  return {
    tone: 'you',
    said: `A person marked the recommendation for ${input.categoryName} ${markWord(mark)}.`,
    because:
      'Saying it needs work writes no new version; a re-run does, and that is a separate click ' +
      'that spends. Until somebody makes it, the request is the newest thing anybody has said ' +
      'about this category.',
    actions: [{ ...read, primary: true }],
  };
}

/** One decimal, because that is what the Shortlist displays and ties share. */
const format = (n: number) => n.toFixed(1);

/**
 * ── The Shortlist and Excluded block's wording ──
 *
 * The words below this line are a second, smaller thing this file holds: not
 * `categoryAnswer()`'s two-sentence verdict, but the fixed strings the
 * Shortlist table itself uses — its empty state, its Excluded block's
 * heading and per-reason text, and the HS-line badge. The Category page's
 * `Shortlist`/`Excluded` sections and the `shortlist_table`/`category_summary`
 * chat widgets draw the same rows through two different renderers, and a
 * sentence written twice is a sentence that drifts: this is what stops
 * "no settled match, no estimated criterion" turning into two different
 * sentences the day one side is edited and the other is not.
 */

/** The Shortlist's empty state — the page's table and the widget's alike. */
export const SHORTLIST_EMPTY_LINE = 'Nothing is ranked here yet.';

/** The Excluded block's heading, page and widget alike (CONTEXT.md's Shortlist entry: excluded is never a low Score). */
export const EXCLUDED_HEADING = 'In this program, but not rankable yet';

/**
 * One record per exclusion reason (SPEC §13.3's two DISTINCT reasons),
 * carrying both the page's full paragraph and the widget's one-line caption
 * — so a reason describes itself once, not twice at two lengths.
 */
export const EXCLUDED_REASONS = {
  no_match: {
    heading: 'No settled match — we could not say which company this is',
    note: 'These carry no score and show no estimated criterion. Opening one shows the resolver’s candidates and rounds, not a breakdown.',
    caption: '— no settled match, no estimated criterion',
  },
  no_category: {
    heading: 'Not mapped to any category in this program',
    note: 'These walk the whole lifecycle and simply reach no shortlist. It is the honest shape of a real roster.',
    caption: '— not mapped to this category',
  },
} as const;

/**
 * The Tariff table's per-HS-line badge. `isDefault` is the one line a
 * Category's Score is computed from; every other HS line the buyer might
 * also import under is shown, never hidden, but is not what `tariffExposure`
 * reads.
 */
export function hsLineBadge(isDefault: boolean): 'scored' | 'candidate' {
  return isDefault ? 'scored' : 'candidate';
}

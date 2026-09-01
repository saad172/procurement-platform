/**
 * What a Supplier page says before anything else.
 *
 * **The pages were named after the pipeline's stages, not the buyer's
 * questions**, and every one of them led with its working and buried its
 * conclusion. Bosch's page runs to 2,707 words: "score 30.1" arrives at word 30
 * with no scale, and the verdict `escalate` at word 609 — as a grey badge
 * weighing exactly as much as the word "assessed" beside it.
 *
 * So the conclusion is computed here, once, as a sentence a manager could act
 * on alone. Putting it in a function rather than in the page has a second point:
 * **there is exactly one answer**, and the order the cases are tested in is the
 * order they matter in. A page that assembled this inline would drift into
 * showing two.
 *
 * The vocabulary is the buyer's. `CONTEXT.md`'s one-meaning-per-word discipline
 * stays load-bearing in the data model and the agent prompts and is **not**
 * rewritten — the canonical term travels alongside, under the `.term` dotted
 * underline, so the surface can speak plainly without the vocabulary going soft
 * underneath.
 */

/** The left rule's colour, and the only colour an answer carries. */
export type AnswerTone =
  /** A reason not to proceed. */
  | 'stop'
  /** Waiting on a person. */
  | 'you'
  /** A clean result. */
  | 'ok'
  /** Nothing has happened yet, which is news but not a problem. */
  | 'neutral';

export type SupplierAnswer = {
  tone: AnswerTone;
  /** The sentence. Complete on its own, and never a bare status word. */
  said: string;
  /** Why, in the buyer's words. */
  because: string;
  /** What to do about it. Empty when there is genuinely nothing to do. */
  actions: { label: string; href?: string; action?: 'assess' | 'enrich'; primary?: boolean }[];
};

export type SupplierAnswerInput = {
  /** What the buyer typed on the roster, or the resolved name for a Lead. */
  name: string;
  match:
    | {
        status: 'accepted' | 'needs_review' | 'not_found';
        settledBy: 'rules' | 'agents' | 'human' | 'discovered';
        entityLabel: string | null;
      }
    | undefined;
  assessment:
    | {
        verdict: 'recommend' | 'recommend_with_conditions' | 'do_not_shortlist' | 'escalate' | null;
        evaluatorOutcome: 'passed' | 'published_with_objections';
        /** The unresolved objections this version published, if any. */
        objections: string[];
      }
    | undefined;
  score: number | null;
  /** Why there is no score, when there is none. */
  scoreAbsentReason: 'no_category' | 'no_match' | 'no_values' | undefined;
  /** Set when a criterion returned a factor that disqualifies outright. */
  disqualifying: boolean;
  /** Where a person settles an unresolved identity. */
  needsReviewHref: string;
  /** Where the objection is written down. */
  assessmentHref: string;
  /** Where this Supplier is compared against the rest of its category. */
  compareHref: string | null;
  /** Named so the compare action can say which category it means. */
  categoryName: string | null;
};

export function supplierAnswer(input: SupplierAnswerInput): SupplierAnswer {
  const { name, match } = input;

  // ── Identity first, because everything below is a claim about a company ──
  //
  // A number about a company nobody has identified is worse than no number, so
  // an unsettled identity outranks every finding underneath it.
  const identity = identityAnswer(input);
  if (identity) return identity;

  // ── Identity is settled. What has been decided about it? ──
  const assessed = assessmentAnswer(input);
  if (assessed) return assessed;

  // ── Identity settled, nothing written yet. Say what is missing, and why ──
  const missing = missingScoreAnswer(input);
  if (missing) return missing;

  return {
    tone: 'neutral',
    said: `${name} has been measured and not yet written up.`,
    because: `We know which company it is${match?.entityLabel ? ` — ${match.entityLabel}` : ''}, and the figures below are computed. Nobody has drawn a conclusion from them, which is the step that produces something you can act on.`,
    actions: [{ label: 'Write the analysis', action: 'assess', primary: true }],
  };
}

/**
 * The three states an unsettled or refused identity can be in, tested before
 * anything downstream — a number about a company nobody has identified is
 * worse than no number.
 */
function identityAnswer(input: SupplierAnswerInput): SupplierAnswer | undefined {
  const { name, match } = input;

  if (!match) {
    return {
      tone: 'neutral',
      said: `Nobody has looked for ${name} yet.`,
      because:
        'Nothing has been run against this row. The first step is finding which company on the graph it is; everything else follows from that.',
      actions: [],
    };
  }

  if (match.status === 'not_found') {
    return {
      tone: 'stop',
      said: `We could not find ${name} on the graph at all.`,
      because:
        'No candidate company was close enough to be worth showing you — not even one in the right country. Nothing can be measured or written about a company we cannot point at, so this row stops here until the name or the address on the roster changes.',
      actions: [{ label: 'See what was searched for', href: input.needsReviewHref }],
    };
  }

  if (match.status === 'needs_review') {
    return {
      tone: 'you',
      said: `${name} is waiting for you to say which company it is.`,
      because:
        'Candidates were found, and two independent reads of them disagreed — or agreed on nothing strong enough to accept. That disagreement is the system declining to guess, and it stops here on purpose: a score and an analysis of the wrong company are worse than neither.',
      actions: [{ label: 'Choose the right company', href: input.needsReviewHref, primary: true }],
    };
  }

  return undefined;
}

/**
 * What a published Assessment says, when there is one — an objection the
 * evaluator did not resolve outranks whatever verdict it was published
 * alongside, because nobody has signed off on it.
 */
function assessmentAnswer(input: SupplierAnswerInput): SupplierAnswer | undefined {
  const { name, assessment } = input;
  if (!assessment) return undefined;

  const compare = input.compareHref
    ? [
        {
          label: input.categoryName
            ? `Compare against the rest of ${input.categoryName}`
            : 'Compare against the rest of the category',
          href: input.compareHref,
        },
      ]
    : [];

  // An analysis published over an unresolved objection is the loudest thing
  // this page can say, whatever verdict it reached. Nobody has signed off.
  if (assessment.evaluatorOutcome === 'published_with_objections') {
    return {
      tone: 'you',
      said: `Escalate — ${name} needs a person, and the write-up says why.`,
      because: `The analysis was published with ${assessment.objections.length === 1 ? 'an unresolved objection' : `${assessment.objections.length} unresolved objections`}: the reviewer disagreed with the author and neither backed down. That is not a failure — it is the system declining to paper over a disagreement — but it means nobody has signed off on ${name}.`,
      actions: [{ label: 'Read the objection', href: input.assessmentHref, primary: true }, ...compare],
    };
  }

  switch (assessment.verdict) {
    case 'do_not_shortlist':
      return {
        tone: 'stop',
        said: `Do not shortlist ${name}.`,
        because: input.disqualifying
          ? 'The analysis found something that rules this supplier out on its own, rather than a low score to be weighed against the others. The finding and what it is cited to are below.'
          : 'The analysis concluded against this supplier on the evidence below. It stays on the roster and keeps its score — nothing here removes it — but it is not one to take forward.',
        actions: [{ label: 'Read the reasoning', href: input.assessmentHref }, ...compare],
      };
    case 'escalate':
      return {
        tone: 'you',
        said: `Escalate — ${name} needs a person.`,
        because:
          'The analysis reached no recommendation it was willing to stand behind. The reasoning below says what it could not settle.',
        actions: [{ label: 'Read the reasoning', href: input.assessmentHref, primary: true }, ...compare],
      };
    case 'recommend_with_conditions':
      return {
        tone: 'ok',
        said: `${name} is worth taking forward, with conditions.`,
        because:
          'The analysis recommends this supplier and names what would have to be true first. The conditions are below, each cited to what it rests on.',
        actions: [{ label: 'Read the conditions', href: input.assessmentHref }, ...compare],
      };
    case 'recommend':
      return {
        tone: 'ok',
        said: `${name} is worth taking forward.`,
        because:
          'The analysis recommends this supplier without conditions, and a second read agreed. The reasoning and its citations are below.',
        actions: [{ label: 'Read the reasoning', href: input.assessmentHref }, ...compare],
      };
    case null:
      return undefined;
  }
}

/** Why there is no score yet, when there is none — settled identity, nothing measured or ranked. */
function missingScoreAnswer(input: SupplierAnswerInput): SupplierAnswer | undefined {
  const { name } = input;
  if (input.score != null) return undefined;

  switch (input.scoreAbsentReason) {
    case 'no_category':
      return {
        tone: 'neutral',
        said: `${name} is mapped to no category in this program, so there is nothing to rank it against.`,
        because:
          'A score is a fit for one category, and this supplier is on no category here. It still carries everything we have measured about the company, and it can still be written up.',
        actions: [{ label: 'Write the analysis', action: 'assess' }],
      };
    case 'no_values':
    default:
      return {
        tone: 'neutral',
        said: `We know which company ${name} is, and we have not looked it up yet.`,
        because:
          'The identity is settled, so there is a company to ask about — but nothing has been fetched, so there is nothing to score and nothing to write from. Fetching runs six sources and costs credits, which is why it is a button rather than something that happens on its own.',
        actions: [{ label: 'Fetch what we can find', action: 'enrich', primary: true }],
      };
  }
}

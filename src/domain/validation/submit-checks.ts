import { candidatesFrom, checkNumberFidelity } from './number-fidelity';

/**
 * The eight code checks in `submit_assessment` / `submit_recommendation`
 * (SPEC §10.4).
 *
 * **The payload arrives before the insert**, so the handler resolves every
 * target id first and nothing is written until all eight pass. That ordering is
 * the whole guarantee: there is no window in which the record contains an
 * unproven claim, and no later scan that could find one.
 *
 * A failure here is a **validator failure**, which costs a Round and is stored
 * as `round(role='evaluator', source='code')` — as distinct from a schema or
 * refinement failure, which is the model mis-shaping its output and retries
 * free (SPEC §10.5).
 */

export type SubmittedSentence = {
  section: string;
  text: string;
  citations: {
    entityId?: string | undefined;
    recordId?: string | undefined;
    enrichmentId?: string | undefined;
    criterionValueId?: string | undefined;
    matchId?: string | undefined;
    shortlist?: { programId: string; categoryId: string } | undefined;
  }[];
  pickSupplierId?: string | undefined;
};

export type SubmittedPick = { supplierId: string; role: string; rank: number };

/** What the handler resolved before running these checks. */
export type ResolvedEvidence = {
  /** Rows keyed by the citation that pointed at them. Absent means dangling. */
  rowsByCitation: Map<string, Record<string, unknown> | undefined>;
  frozenInputs: Record<string, unknown>;
  /** Per Supplier, what the picks and eligibility checks need to know. */
  suppliers: Map<
    string,
    {
      name: string;
      matchAccepted: boolean;
      categoryIds: string[];
      hasScore: boolean;
      disqualifying: boolean;
      /** Set when this Supplier's own Assessment published with objections. */
      publishedWithObjections: boolean;
      onShortlist: boolean;
    }
  >;
  /** Criteria that returned `unknown`, which `limits` must name. */
  unknownCriteria: string[];
  /** Caveats the sections that require them must carry. */
  mandatoryCaveats: { section: string; mustMention: RegExp; describedAs: string }[];
};

export type Objection = { check: string; message: string };

/** Sections an Assessment must always have, with `limits` never empty. */
const ASSESSMENT_REQUIRED = ['identity', 'limits'] as const;
const RECOMMENDATION_REQUIRED = ['headline'] as const;

const citationKey = (c: SubmittedSentence['citations'][number]): string =>
  JSON.stringify(c, Object.keys(c).sort());

/**
 * Runs all eight and returns every objection.
 *
 * Returning all of them rather than the first matters because each rejection
 * costs a Round: a Round that fixes one problem and reveals another has spent
 * the budget twice for one submission.
 */
export function checkAssessment(args: {
  verdict: string | null;
  sentences: SubmittedSentence[];
  supplierId: string;
  evidence: ResolvedEvidence;
}): Objection[] {
  const objections: Objection[] = [];
  const supplier = args.evidence.suppliers.get(args.supplierId);

  objections.push(...checkCitationsResolve(args.sentences, args.evidence));
  objections.push(...checkNumbers(args.sentences, args.evidence));
  objections.push(...checkCaveats(args.sentences, args.evidence));
  objections.push(...checkRequiredSections(args.sentences, ASSESSMENT_REQUIRED, 'assessment'));
  objections.push(...checkLimitsNamesUnknowns(args.sentences, args.evidence));

  // Check 7: the disqualifying badge FORCES the verdict, and code does not
  // choose between the two — that is a judgement.
  if (supplier?.disqualifying && args.verdict !== 'do_not_shortlist' && args.verdict !== 'escalate') {
    objections.push({
      check: 'disqualifying_badge',
      message:
        `${supplier.name} carries a disqualifying risk factor, so the verdict must be "do_not_shortlist" or "escalate". ` +
        `Which of the two is your judgement; the code will not make it for you.`,
    });
  }

  // A tariff section is legal only where the Supplier has a Category — which is
  // what keeps the eight uncategorised Suppliers legal.
  if (
    args.sentences.some((s) => s.section === 'tariff') &&
    supplier &&
    supplier.categoryIds.length === 0
  ) {
    objections.push({
      check: 'required_sections',
      message: `${supplier.name} bids on no category, so there is no tariff to write about. Remove the tariff section.`,
    });
  }

  return objections;
}

export function checkRecommendation(args: {
  picks: SubmittedPick[];
  sentences: SubmittedSentence[];
  categoryId: string;
  evidence: ResolvedEvidence;
}): Objection[] {
  const objections: Objection[] = [];

  objections.push(...checkCitationsResolve(args.sentences, args.evidence));
  objections.push(...checkNumbers(args.sentences, args.evidence));
  objections.push(...checkCaveats(args.sentences, args.evidence));
  objections.push(...checkRequiredSections(args.sentences, RECOMMENDATION_REQUIRED, 'recommendation'));

  // Exactly one headline.
  const headlines = args.sentences.filter((s) => s.section === 'headline');
  if (headlines.length !== 1) {
    objections.push({
      check: 'required_sections',
      message: `A recommendation carries exactly one headline sentence; this one has ${headlines.length}.`,
    });
  }

  objections.push(...checkPickLegality(args.picks, args.sentences, args.categoryId, args.evidence));
  objections.push(...checkUpstreamDisclosure(args.sentences, args.evidence));

  // A condition attaches to the pick it conditions.
  const pickIds = new Set(args.picks.map((p) => p.supplierId));
  for (const sentence of args.sentences) {
    if (!sentence.pickSupplierId) continue;
    if (sentence.section !== 'conditions') {
      objections.push({
        check: 'required_sections',
        message: 'A sentence may attach to a pick only in the conditions section.',
      });
    } else if (!pickIds.has(sentence.pickSupplierId)) {
      objections.push({
        check: 'pick_legality',
        message: `A condition attaches to ${sentence.pickSupplierId}, which is not one of the picks.`,
      });
    }
  }

  return objections;
}

// ── Check 1: every sentence carries a citation resolving to a live row ───────

function checkCitationsResolve(
  sentences: readonly SubmittedSentence[],
  evidence: ResolvedEvidence,
): Objection[] {
  const objections: Objection[] = [];
  for (const sentence of sentences) {
    if (sentence.citations.length === 0) {
      objections.push({
        check: 'citations',
        message: `This sentence carries no citation and cannot be inserted: "${truncate(sentence.text)}"`,
      });
      continue;
    }
    for (const citation of sentence.citations) {
      const key = citationKey(citation);
      if (!evidence.rowsByCitation.has(key) || evidence.rowsByCitation.get(key) === undefined) {
        objections.push({
          check: 'citations',
          message:
            `A citation on "${truncate(sentence.text)}" points at a row that does not exist: ${key}. ` +
            `A citation points at stored evidence, so this cannot be inserted.`,
        });
      }
    }
  }
  return objections;
}

// ── Check 2: number fidelity ────────────────────────────────────────────────

function checkNumbers(sentences: readonly SubmittedSentence[], evidence: ResolvedEvidence): Objection[] {
  const objections: Objection[] = [];
  for (const sentence of sentences) {
    const citedRows = sentence.citations
      .map((c) => evidence.rowsByCitation.get(citationKey(c)))
      .filter((row): row is Record<string, unknown> => row != null);

    for (const failure of checkNumberFidelity(sentence.text, candidatesFrom(evidence.frozenInputs, citedRows))) {
      objections.push({
        check: 'number_fidelity',
        message: `In "${truncate(sentence.text)}": ${failure.message}`,
      });
    }
  }
  return objections;
}

// ── Check 3: mandatory caveats ──────────────────────────────────────────────

/**
 * A section that requires a caveat must carry it.
 *
 * The tariff caveat is the standing example: the rate is an MFN figure for one
 * importer, trade-action flags are not folded into it, and an aged figure has
 * to say so. Rendering the number without the caveat is how a proxy becomes a
 * fact.
 */
function checkCaveats(sentences: readonly SubmittedSentence[], evidence: ResolvedEvidence): Objection[] {
  const objections: Objection[] = [];
  for (const required of evidence.mandatoryCaveats) {
    const inSection = sentences.filter((s) => s.section === required.section);
    if (inSection.length === 0) continue;
    if (!inSection.some((s) => required.mustMention.test(s.text))) {
      objections.push({
        check: 'caveats',
        message: `The ${required.section} section is missing a mandatory caveat: ${required.describedAs}`,
      });
    }
  }
  return objections;
}

// ── Check 5: required sections, and `limits` non-empty ──────────────────────

function checkRequiredSections(
  sentences: readonly SubmittedSentence[],
  required: readonly string[],
  kind: string,
): Objection[] {
  const objections: Objection[] = [];
  for (const section of required) {
    if (!sentences.some((s) => s.section === section && s.text.trim().length > 0)) {
      objections.push({
        check: 'required_sections',
        message: `Every ${kind} must carry a non-empty "${section}" section.`,
      });
    }
  }
  // `dissent` is assembled from unresolved objections and is never authored.
  if (sentences.some((s) => s.section === 'dissent')) {
    objections.push({
      check: 'required_sections',
      message: 'Nobody writes dissent — it is assembled from the objections a version published without resolving.',
    });
  }
  return objections;
}

/**
 * `limits` must **name every `unknown` Criterion**.
 *
 * That is what stops the rest of the document reading as more certain than it
 * is, and it is why `limits` is the one section that may never be empty.
 */
function checkLimitsNamesUnknowns(
  sentences: readonly SubmittedSentence[],
  evidence: ResolvedEvidence,
): Objection[] {
  const limits = sentences.filter((s) => s.section === 'limits').map((s) => s.text.toLowerCase()).join(' ');
  const missing = evidence.unknownCriteria.filter((key) => !limitsNames(limits, key));
  return missing.length === 0
    ? []
    : [
        {
          check: 'caveats',
          message:
            `The limits section must name every criterion that returned unknown. Missing: ${missing.join(', ')}. ` +
            `Write the criterion's own words in a limits sentence — "${missing[0]!.replace(/_/g, ' ')}" — not a paraphrase of them.`,
        },
      ];
}

/**
 * Whether a limits section names one criterion.
 *
 * **The head word is enough, and it has to be.** The check used to demand the
 * whole key, `tariff_exposure` or `tariff exposure`, as a literal substring. A
 * draft that said *"One tariff criterion returned unknown, with the stored
 * reason that no MFN rate was returned for HS 8504.40"* named the criterion,
 * gave its reason, and was rejected — three Rounds of it, then a Job that
 * published nothing.
 *
 * That is a check objecting to phrasing rather than to substance, which this
 * codebase has been caught by once already (see the entity-id shape in
 * `number-fidelity`). What the reader needs is to find every unknown criterion
 * in the limits section; *tariff* finds it. The scope is already narrow — only
 * `limits` sentences are searched, and a limits section is where a writer talks
 * about what is missing — so the head word carries little risk of a false pass
 * and removes a real class of false rejection.
 *
 * The objection still asks for the criterion's full words, because a document
 * that uses them reads better. It is guidance the writer can follow, not a
 * gate it can fail on wording alone.
 */
function limitsNames(limits: string, key: string): boolean {
  if (limits.includes(key) || limits.includes(key.replace(/_/g, ' '))) return true;
  const head = key.split('_')[0]!;
  return head.length >= 4 && new RegExp(String.raw`\b${head}\b`).test(limits);
}

// ── Checks 4 and 6: eligibility and pick legality ───────────────────────────

/**
 * **A Supplier with no accepted Match is never a Pick** — it is excluded, and
 * the exclusion is said in a sentence.
 *
 * At most three picks and at most one `award`. A non-rank-1 `award` must be
 * argued for, citing that Supplier's own `criterion_value` or the Shortlist.
 */
function checkPickLegality(
  picks: readonly SubmittedPick[],
  sentences: readonly SubmittedSentence[],
  categoryId: string,
  evidence: ResolvedEvidence,
): Objection[] {
  const objections: Objection[] = [];

  if (picks.length > 3) {
    objections.push({ check: 'pick_legality', message: `At most three picks; this recommendation names ${picks.length}.` });
  }
  const awards = picks.filter((p) => p.role === 'award');
  if (awards.length > 1) {
    objections.push({ check: 'pick_legality', message: `At most one award; this recommendation names ${awards.length}.` });
  }

  for (const pick of picks) {
    const supplier = evidence.suppliers.get(pick.supplierId);
    if (!supplier) {
      objections.push({ check: 'eligibility', message: `Pick ${pick.supplierId} is not a supplier of this program.` });
      continue;
    }
    if (!supplier.matchAccepted) {
      objections.push({
        check: 'eligibility',
        message: `${supplier.name} has no accepted match, so it cannot be a pick. Exclude it, and say why in a sentence.`,
      });
    }
    if (!supplier.categoryIds.includes(categoryId)) {
      objections.push({
        check: 'eligibility',
        message: `${supplier.name} does not bid on this category, so it cannot be picked for it.`,
      });
    }
    if (!supplier.hasScore) {
      objections.push({ check: 'pick_legality', message: `${supplier.name} has no score for this category.` });
    }
    // The disqualifying badge bars an award or a second source — but not a
    // `develop` or an `avoid`, which are judgements about a company you are NOT
    // buying from yet.
    if (supplier.disqualifying && (pick.role === 'award' || pick.role === 'second_source')) {
      objections.push({
        check: 'disqualifying_badge',
        message: `${supplier.name} carries a disqualifying risk factor, so it cannot be an award or a second source.`,
      });
    }
  }

  // Departing from rank order is PERMITTED but must be cited.
  for (const award of awards) {
    if (award.rank === 1) continue;
    const argued = sentences.some(
      (s) =>
        s.section === 'rationale' &&
        s.citations.some((c) => c.criterionValueId != null || c.shortlist != null),
    );
    if (!argued) {
      const name = evidence.suppliers.get(award.supplierId)?.name ?? award.supplierId;
      objections.push({
        check: 'pick_legality',
        message:
          `${name} is awarded from rank ${award.rank} rather than rank 1. Departing from the order is allowed, ` +
          `but it must be argued for: add a rationale sentence citing a criterion value or the shortlist.`,
      });
    }
  }

  return objections;
}

// ── Check 8: upstream disclosure ────────────────────────────────────────────

/**
 * A Shortlist Supplier whose own Assessment ended `published_with_objections`
 * must be **named in an `open_questions` sentence**.
 *
 * Inheriting an unresolved disagreement silently is the failure this closes: a
 * Recommendation may not cite an Assessment, so without this rule the objection
 * would simply vanish at the boundary.
 */
function checkUpstreamDisclosure(
  sentences: readonly SubmittedSentence[],
  evidence: ResolvedEvidence,
): Objection[] {
  const openQuestions = sentences
    .filter((s) => s.section === 'open_questions')
    .map((s) => s.text.toLowerCase())
    .join(' ');

  const undisclosed = [...evidence.suppliers.values()].filter(
    (s) => s.onShortlist && s.publishedWithObjections && !openQuestions.includes(s.name.toLowerCase()),
  );

  return undisclosed.map((s) => ({
    check: 'upstream_disclosure',
    message:
      `${s.name}'s assessment published with unresolved objections, and it is on this shortlist. ` +
      `Name it in an open question — an unresolved disagreement must not vanish at the boundary.`,
  }));
}

function truncate(text: string, length = 60): string {
  return text.length <= length ? text : `${text.slice(0, length)}…`;
}

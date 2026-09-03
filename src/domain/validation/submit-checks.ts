import { canonicalJson } from '@/lib/canonical-json';
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
      /**
       * The accepted Profile's entity id, or `null` with no accepted Match —
       * the same nullability `SupplierSnapshot.entityId` carries
       * (`src/db/queries/shortlist.ts`). Added for check 9 (network spec §7):
       * the recommend Job needs a Pick's entity id to call
       * `findAndWriteShortestPath` against the award's, and the evidence
       * already resolved per Supplier is where every other Pick fact lives.
       */
      entityId: string | null;
      categoryIds: string[];
      /**
       * The Categories this Supplier has a Score on — **per Category, because a
       * Score is** (SPEC §9). It was one boolean over every Criterion value the
       * Supplier held, while the objection it produces says *"has no score for
       * this category"*: a Supplier scored in one Category and not in another
       * answered that objection with the wrong Category's evidence.
       */
      categoriesWithScore: string[];
      /**
       * The badge as `score.ts` lights it — `isDisqualifying(factor)` on any
       * risk factor, **or** `sanctioned`. Reading `sanctioned` alone made this
       * check narrower than the badge it enforces, so the pick bar and check 7
       * passed Suppliers the Shortlist was showing as disqualified.
       */
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

/**
 * One Concentration (network spec §3, §7): the award and one other Pick in
 * the same Recommendation, joined by a Path `findAndWriteShortestPath`
 * (`src/jobs/shortest-path.ts`) found between them. Built by the recommend
 * Job's `validateRecommendDraft` — never by this file reaching into `upstream`
 * itself, which is why check 9 below takes it as a plain array rather than
 * computing it.
 */
export type ConcentrationPair = {
  awardSupplierId: string;
  secondSourceSupplierId: string;
  /** The shared entity the Path terminates at — cited as `{ entityId }`. */
  terminalEntityId: string;
};

/** Sections an Assessment must always have, with `limits` never empty. */
const ASSESSMENT_REQUIRED = ['identity', 'limits'] as const;
const RECOMMENDATION_REQUIRED = ['headline'] as const;

/**
 * A stable key for a citation, so validation and the insert agree on identity.
 *
 * **Built on `canonicalJson`, which sorts at every level.** The first version
 * was `JSON.stringify(c, Object.keys(c).sort())`, and a replacer *array* is not
 * a key order — it is a **filter applied at every depth**. So the only keys
 * that survived were the top-level ones the citation happened to carry, and
 * every Shortlist citation `{shortlist: {programId, categoryId}}` serialised as
 * `{"shortlist":{}}`.
 *
 * Two consequences, both real:
 *
 * 1. `resolveCitations` dedupes by this key, so **the first Shortlist citation
 *    in a document was looked up and its result reused for every other one** —
 *    a second, different (program, category) pair was never queried.
 * 2. A bogus pair therefore passed `checkCitationsResolve` on the back of a
 *    valid one, and failed inside the publish transaction on the foreign key —
 *    three Rounds after the check that exists to catch it.
 *
 * It lives here rather than in `publish.ts` because the check is what needs it
 * to be right; the insert reads the same function so the two cannot drift.
 */
export const citationKey = (c: SubmittedSentence['citations'][number]): string => canonicalJson(c);

/**
 * How an unresolved citation is **named in the sentence the model reads**,
 * which is a different question from how it is identified.
 *
 * It keeps `JSON.stringify(c, Object.keys(c).sort())` — the serialisation
 * `citationKey` used to be — and that is deliberate rather than an oversight,
 * with a cost that has to be said out loud: a replacer *array* filters keys at
 * every depth, so a Shortlist citation renders as `{"shortlist":{}}` and the
 * model is not told **which** (program, category) pair failed.
 *
 * The reason it stays is that this string is quoted verbatim into the next
 * Round's request — `carriedObjections` is the objection's `message` — so its
 * bytes are a **prompt**, and changing them moves a recorded fixture
 * (`assess/published-with-objections`, whose Round 1 contains exactly this
 * citation) that cannot be re-recorded in this change. The thing the bug was
 * actually about — the identity the checks, the dedupe and the insert agree on
 * — is `citationKey`, and that is canonical now, so a bogus pair is refused
 * here instead of by a foreign key three Rounds later.
 *
 * Widening the wording is a one-line change plus a re-record, and it is worth
 * making the next time this fixture is re-recorded for a reason of its own.
 */
function citationLabel(c: SubmittedSentence['citations'][number]): string {
  return JSON.stringify(c, Object.keys(c).sort());
}

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
  if (
    supplier?.disqualifying &&
    args.verdict !== 'do_not_shortlist' &&
    args.verdict !== 'escalate'
  ) {
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
  /** Every Concentration this Round's picks turned up (§7). Defaults to none. */
  concentrations?: ConcentrationPair[];
}): Objection[] {
  const objections: Objection[] = [];

  objections.push(...checkCitationsResolve(args.sentences, args.evidence));
  objections.push(...checkNumbers(args.sentences, args.evidence));
  objections.push(...checkCaveats(args.sentences, args.evidence));
  objections.push(
    ...checkRequiredSections(args.sentences, RECOMMENDATION_REQUIRED, 'recommendation'),
  );

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
  objections.push(
    ...checkConcentration(args.picks, args.sentences, args.concentrations ?? [], args.evidence),
  );

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
            `A citation on "${truncate(sentence.text)}" points at a row that does not exist: ${citationLabel(citation)}. ` +
            `A citation points at stored evidence, so this cannot be inserted.`,
        });
      }
    }
  }
  return objections;
}

// ── Check 2: number fidelity ────────────────────────────────────────────────

function checkNumbers(
  sentences: readonly SubmittedSentence[],
  evidence: ResolvedEvidence,
): Objection[] {
  const objections: Objection[] = [];
  for (const sentence of sentences) {
    const citedRows = sentence.citations
      .map((c) => evidence.rowsByCitation.get(citationKey(c)))
      .filter((row): row is Record<string, unknown> => row != null);

    for (const failure of checkNumberFidelity(
      sentence.text,
      candidatesFrom(evidence.frozenInputs, citedRows),
    )) {
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
function checkCaveats(
  sentences: readonly SubmittedSentence[],
  evidence: ResolvedEvidence,
): Objection[] {
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
      message:
        'Nobody writes dissent — it is assembled from the objections a version published without resolving.',
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
  const limits = sentences
    .filter((s) => s.section === 'limits')
    .map((s) => s.text.toLowerCase())
    .join(' ');
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
 * Whether a limits section names one criterion: **its key, or its key with the
 * underscores as spaces.** Nothing shorter.
 *
 * The check once demanded exactly that and was loosened to accept the key's
 * head word, because a draft saying *"One tariff criterion returned unknown,
 * with the stored reason that no MFN rate was returned for HS 8504.40"* was
 * rejected three Rounds running for naming the criterion in its own words
 * rather than in ours. The rejection was wrong; the remedy was too broad.
 *
 * **A head word is an ordinary word in the one section it is searched in.** The
 * limits section is where a writer talks about tariffs, about media coverage,
 * about the country — so *"the tariff rate is an MFN figure for one importer"*
 * satisfied `tariff_exposure`, and *"no adverse media search was run for the
 * parent"* satisfied `media_signal`, neither sentence saying the Criterion
 * returned unknown at all. Four characters of a shared vocabulary is not a
 * name, and this check's whole job is to make sure a reader can find every
 * `unknown` Criterion in the section that exists to admit them.
 *
 * The objection already asks for the criterion's own words and quotes them, so
 * the writer is told exactly what to write rather than left to guess which
 * paraphrase will pass.
 */
function limitsNames(limits: string, key: string): boolean {
  return limits.includes(key) || limits.includes(key.replace(/_/g, ' '));
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
    objections.push({
      check: 'pick_legality',
      message: `At most three picks; this recommendation names ${picks.length}.`,
    });
  }
  const awards = picks.filter((p) => p.role === 'award');
  if (awards.length > 1) {
    objections.push({
      check: 'pick_legality',
      message: `At most one award; this recommendation names ${awards.length}.`,
    });
  }

  for (const pick of picks) {
    const supplier = evidence.suppliers.get(pick.supplierId);
    if (!supplier) {
      objections.push({
        check: 'eligibility',
        message: `Pick ${pick.supplierId} is not a supplier of this program.`,
      });
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
    if (!supplier.categoriesWithScore.includes(categoryId)) {
      objections.push({
        check: 'pick_legality',
        message: `${supplier.name} has no score for this category.`,
      });
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

  const everyName = [...evidence.suppliers.values()].map((s) => s.name.toLowerCase());
  const undisclosed = [...evidence.suppliers.values()].filter(
    (s) =>
      s.onShortlist &&
      s.publishedWithObjections &&
      !namesSupplier(openQuestions, s.name.toLowerCase(), everyName),
  );

  return undisclosed.map((s) => ({
    check: 'upstream_disclosure',
    message:
      `${s.name}'s assessment published with unresolved objections, and it is on this shortlist. ` +
      `Name it in an open question — an unresolved disagreement must not vanish at the boundary.`,
  }));
}

/**
 * Whether the open questions name **this** Supplier, as against one whose name
 * happens to contain its own.
 *
 * A bare `includes()` disclosed the wrong company: a roster carries *Sumitomo
 * Electric* beside *Sumitomo*, and *Aptiv* beside *Aptiv Services*, so an open
 * question about the longer one silently satisfied the check for the shorter —
 * and the check exists precisely so that an unresolved disagreement cannot
 * vanish at the boundary. A rule whose failure mode is *"we disclosed a
 * different company"* is worse than no rule, because it reads as compliance.
 *
 * So an occurrence counts only where it stands as a whole name: bounded by
 * something other than a letter or a digit, and not sitting inside a mention of
 * a longer Supplier name that contains it.
 */
function namesSupplier(text: string, name: string, everyName: readonly string[]): boolean {
  const mine = occurrencesOf(text, name);
  if (mine.length === 0) return false;

  const inside = everyName
    .filter((other) => other !== name && other.includes(name))
    .flatMap((other) => occurrencesOf(text, other));

  return mine.some(([start, end]) => !inside.some(([from, to]) => from <= start && end <= to));
}

// ── Check 9: concentration ───────────────────────────────────────────────────

/**
 * The award and another Pick joined by a Path is a Concentration (network
 * spec §3, §7) — a shared parent, or one owning the other — that a Pick's own
 * Score says nothing about. Silence is the failure this closes, and it is
 * check 8's shape exactly: an unresolved fact must not vanish at the
 * boundary, resolved either by naming it or by the fact itself no longer
 * holding, re-evaluated fresh on every Round because this check, like check
 * 8, reads nothing but the current draft and the pairs `validateRecommendDraft`
 * (`src/jobs/recommend.ts`) computed for it — never `upstream` itself.
 *
 * Resolved when EITHER:
 *
 * 1. Conditions or open questions **name the second source** — `namesSupplier`,
 *    exactly as check 8 requires a Supplier be named rather than merely
 *    implied. Naming the second source (there is at most one award per
 *    Recommendation — `checkPickLegality` — so it alone identifies which
 *    Concentration is meant) is enough; the objection's own message tells the
 *    writer which entity id to cite so the Path is not just named but backed.
 * 2. The **second source has been re-roled** away from `second_source` in
 *    THIS Round's own picks — mirroring how check 8's disclosure is judged
 *    against the state `evidence` carries for the Round being validated, not
 *    against any earlier Round's. (In practice this branch rarely fires here:
 *    `validateRecommendDraft` only asks `findAndWriteShortestPath` about picks
 *    that are `second_source` *in this Round*, so a re-roled pick usually
 *    never reaches `concentrations` at all. It stays as an explicit condition
 *    — not folded into "concentrations already excludes it" — so this check
 *    does not silently depend on its caller's own filtering to stay correct.)
 */
function checkConcentration(
  picks: readonly SubmittedPick[],
  sentences: readonly SubmittedSentence[],
  concentrations: readonly ConcentrationPair[],
  evidence: ResolvedEvidence,
): Objection[] {
  if (concentrations.length === 0) return [];

  const disclosureText = sentences
    .filter((s) => s.section === 'conditions' || s.section === 'open_questions')
    .map((s) => s.text.toLowerCase())
    .join(' ');
  const everyName = [...evidence.suppliers.values()].map((s) => s.name.toLowerCase());

  const objections: Objection[] = [];
  for (const pair of concentrations) {
    const stillSecondSource = picks.some(
      (p) => p.supplierId === pair.secondSourceSupplierId && p.role === 'second_source',
    );
    if (!stillSecondSource) continue; // Resolved — re-roled away.

    const secondSourceName =
      evidence.suppliers.get(pair.secondSourceSupplierId)?.name ?? pair.secondSourceSupplierId;
    if (namesSupplier(disclosureText, secondSourceName.toLowerCase(), everyName)) continue; // Resolved — named.

    const awardName = evidence.suppliers.get(pair.awardSupplierId)?.name ?? pair.awardSupplierId;
    objections.push({
      check: 'concentration',
      message:
        `${awardName} (the award) and ${secondSourceName} (a second source) are joined by a Path — ` +
        `a Concentration. Name ${secondSourceName} in a conditions or open_questions sentence, citing ` +
        `entityId: ${pair.terminalEntityId} for the Path, or re-role ${secondSourceName} away from second_source.`,
    });
  }
  return objections;
}

const isNameCharacter = (character: string | undefined): boolean =>
  character != null && /[\p{L}\p{N}]/u.test(character);

/** Every whole-word span of `needle` in `text`, as `[start, end)` offsets. */
function occurrencesOf(text: string, needle: string): [number, number][] {
  const spans: [number, number][] = [];
  if (needle.length === 0) return spans;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
    const end = at + needle.length;
    // "Denso" inside "Densomatic" is not a mention of Denso.
    if (isNameCharacter(text[at - 1]) || isNameCharacter(text[end])) continue;
    spans.push([at, end]);
  }
  return spans;
}

function truncate(text: string, length = 60): string {
  return text.length <= length ? text : `${text.slice(0, length)}…`;
}

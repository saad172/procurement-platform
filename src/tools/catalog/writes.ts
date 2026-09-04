import { z } from 'zod/v4';
import { rubricItem } from '@/db/schema/enums';
import { defineTool } from '../define';

/**
 * Family 5: the agent writes (SPEC §15.2, §15.4).
 *
 * **There is no `submit_match` tool.** The agents *propose* and our code
 * *settles*, so the invariant is not "no `submit_match` reachable from chat"
 * but the stronger:
 *
 *   > **No tool in the registry, on any surface, writes `match.status` or
 *   > `match.entity_id`.**
 *
 * Enforced by an ESLint import boundary rather than a test, because the failure
 * it exists to stop is *a tool added later without thinking about it*, which no
 * amount of iterating over `defineTool` results can see.
 *
 * Every one of these returns a **schema-enforced structure, never prose**, and
 * `strict: true` is on every model-facing tool — so a JSON Schema violation is
 * impossible rather than merely caught.
 */

const discriminatorVerdict = z.object({
  discriminator: z.enum([
    'country',
    'locality',
    'street',
    'name_cover',
    'alias_context',
    'lei_witness',
    'business_purpose',
    'liveness',
  ]),
  // "Can't tell" is a verdict distinct from "failed": the real company may
  // simply have no LEI, and that is not evidence against it.
  verdict: z.enum(['pass', 'fail', 'unavailable']),
  reasoning: z.string().describe('One line. Why this verdict, from the evidence in front of you.'),
});

/** The resolver's proposal. It proposes; `settleMatch()` settles. */
const submitMatchProposal = defineTool({
  name: 'submit_match_proposal',
  description:
    'Propose which company this roster row refers to, with a verdict for every discriminator. You are proposing, not deciding.',
  input: z.object({
    entityId: z.string().nullable().describe('null when no candidate should be accepted'),
    verdicts: z.array(discriminatorVerdict).length(8),
    confidence: z.enum(['low', 'medium', 'high']),
    reasoning: z.string(),
  }),
  surfaces: ['job'],
  effect: 'write',
  spends: [],
  latency: 'fast',
  handler: async (input) => ({ ok: true, data: input }),
});

/** The blind evaluator's independent pick. Agreement is our code, not its word. */
const submitMatchVerdict = defineTool({
  name: 'submit_match_verdict',
  description:
    'Name which company this roster row refers to, from the candidates in front of you, with a verdict for every discriminator.',
  input: z.object({
    entityId: z.string().nullable(),
    verdicts: z.array(discriminatorVerdict).length(8),
    confidence: z.enum(['low', 'medium', 'high']),
    reasoning: z.string(),
  }),
  surfaces: ['job'],
  effect: 'write',
  spends: [],
  latency: 'fast',
  handler: async (input) => ({ ok: true, data: input }),
});

/**
 * The five scalar target fields. `shortlist` is the sixth target group — a
 * pair of columns in the database, but one field here — so it is counted
 * alongside these rather than folded into the list.
 */
const CITATION_SCALAR_TARGET_FIELDS = [
  'entityId',
  'recordId',
  'enrichmentId',
  'criterionValueId',
  'matchId',
] as const;

/**
 * One citation: the id of a stored thing, named by the one field it belongs
 * in.
 *
 * **Exactly one target group per citation, and each field says where its id
 * comes from.**
 *
 * These fields carried no descriptions at all, and a recommendation put a
 * *supplier* id in `recordId` — the only slot it does not belong in. The
 * foreign key refused it three Rounds later, having spent the whole budget on
 * a mistake nothing had ever told the model how to avoid.
 *
 * A schema that names the source of each id is the cheapest possible fix, and
 * the right one: an id's meaning is not guessable from its shape, since every
 * one of these is a uuid.
 *
 * The "exactly one" part of that sentence was prose only — nothing stopped a
 * citation naming two or more target fields at once, and a model that did so
 * would only find out from the database's own CHECK constraint, which fails
 * the whole insert rather than telling the model what to fix. The
 * `superRefine` below counts the same six groups the database CHECK counts —
 * five scalar fields plus `shortlist` as one pair — and rejects more than one,
 * so this is a schema failure the model can read and correct rather than a
 * constraint violation nothing recovers from. Zero fields is deliberately left
 * alone here: a citation naming nothing already fails to resolve, and that is
 * reported as an objection elsewhere.
 */
const citationTarget = z
  .object({
    entityId: z
      .string()
      .optional()
      .describe(
        'A Sayari entity id, as returned by sayari_get_entity or get_supplier. Not a uuid.',
      ),
    recordId: z
      .string()
      .optional()
      .describe(
        'A Sayari SOURCE RECORD id, which exists locally only after sayari_get_record has fetched it. Never a supplier, entity or criterion id.',
      ),
    enrichmentId: z
      .string()
      .optional()
      .describe('The `id` of a row in the enrichments list returned by get_supplier.'),
    criterionValueId: z
      .string()
      .optional()
      .describe(
        "The `id` from get_assessment_brief's criterionValueIds, or from get_supplier's criterionValues.",
      ),
    matchId: z
      .string()
      .optional()
      .describe(
        "The `matchId` from get_assessment_brief, or the match's `id` from get_supplier.",
      ),
    shortlist: z
      .object({
        programId: z
          .string()
          .describe(
            "The program's `id` from get_program or get_shortlist — a uuid, never its name.",
          ),
        categoryId: z
          .string()
          .describe("The category's `id` — a uuid, never its code like 'HAR'."),
      })
      .optional()
      .describe(
        'Both halves, for a claim about the shortlist itself rather than about one supplier.',
      ),
  })
  .superRefine((citation, ctx) => {
    const present = [
      ...CITATION_SCALAR_TARGET_FIELDS.filter((field) => citation[field] != null),
      ...(citation.shortlist != null ? ['shortlist'] : []),
    ];
    if (present.length > 1) {
      ctx.addIssue(
        `A citation names exactly one target group, never more than one. This one names ${present.length}: ${present.join(', ')}.`,
      );
    }
  });

/**
 * A sentence and the rows it cites. The pair is inseparable by construction.
 *
 * `section` mirrors `sentenceSection` (`src/db/schema/enums.ts`) — the DB enum
 * `ownership` renamed to `network` in ticket 03a, and this schema was the one
 * place that rename missed: a model submitting `section: 'network'` (as the
 * renamed prompt in `src/model/prompts/assess.ts` now asks for) failed this
 * refinement, and a model still submitting `'ownership'` would have failed
 * the DB's own enum instead. Fixed here rather than left for a later ticket
 * because the two enums disagreeing makes every Assessment submission fail.
 */
const citedSentence = z.object({
  section: z.enum([
    'identity',
    'compliance',
    'network',
    'country',
    'tariff',
    'media',
    'limits',
    'headline',
    'rationale',
    'conditions',
    'open_questions',
  ]),
  text: z.string(),
  citations: z
    .array(citationTarget)
    .min(1)
    .describe(
      'At least one, each naming exactly one target. A sentence without a citation cannot be inserted, and an id in the wrong field is refused by the database.',
    ),
  pickSupplierId: z.string().optional().describe('Only in the conditions section'),
});

const submitAssessment = defineTool({
  name: 'submit_assessment',
  description:
    'Submit the finished assessment. Every sentence must carry a citation to a stored row; the handler resolves every id before inserting anything.',
  input: z.object({
    // An enum is not a claim and cannot dangle, which is the only reason the
    // verdict needs no citation.
    verdict: z.enum(['recommend', 'recommend_with_conditions', 'do_not_shortlist', 'escalate']),
    sentences: z.array(citedSentence).min(1),
  }),
  surfaces: ['job'],
  effect: 'write',
  spends: [],
  latency: 'fast',
  handler: async (input) => ({ ok: true, data: input }),
});

const submitRecommendation = defineTool({
  name: 'submit_recommendation',
  description:
    'Submit the finished recommendation with its typed picks. Every sentence must carry a citation; picks are checked for legality before anything is inserted.',
  input: z.object({
    picks: z
      .array(
        z.object({
          supplierId: z.string(),
          role: z.enum(['award', 'second_source', 'develop', 'avoid']),
          rank: z.number().int().min(1),
        }),
      )
      .max(3)
      .describe('At most three, and at most one award.'),
    sentences: z.array(citedSentence).min(1),
  }),
  surfaces: ['job'],
  effect: 'write',
  spends: [],
  latency: 'fast',
  handler: async (input) => ({ ok: true, data: input }),
});

/**
 * The six rubric items (SPEC §10.3), taken from the database enum so the
 * verdict the evaluator submits and the verdict a `round` row records cannot
 * drift into two lists that mean the same thing.
 */
export const RUBRIC_ITEMS = rubricItem.enumValues;

/**
 * One rubric item's verdict.
 *
 * `unavailable` is a verdict distinct from `fail`, exactly as *can't tell* is
 * for a Discriminator: an item the evaluator could not check is not an item the
 * draft failed, and only `fail` carries forward as an objection.
 */
const rubricVerdict = z.object({
  item: z.enum(RUBRIC_ITEMS),
  verdict: z.enum(['pass', 'fail', 'unavailable']),
  reasoning: z
    .string()
    .describe(
      'One line. Where this fails, say what specifically is wrong — this line is the objection the writer answers.',
    ),
});

/**
 * The evaluator's verdict, as a payload rather than as prose (SPEC §10.3).
 *
 * Exported because the Job parses the submitted payload with **this** schema:
 * the tool's `run()` may or may not execute (finding 21), so the verdict is
 * read out of the `tool_use` block the model emitted and validated here, which
 * is the same path `submit_assessment` and `submit_recommendation` take.
 */
export const EVALUATION_PAYLOAD = z.object({
  items: z
    .array(rubricVerdict)
    .length(RUBRIC_ITEMS.length)
    .describe('One verdict per rubric item, all six, in any order.'),
  summary: z.string().describe('What you concluded overall, in your own words.'),
});

export type EvaluationPayload = z.infer<typeof EVALUATION_PAYLOAD>;

/**
 * The evaluator's write, and the only way its review is recorded.
 *
 * It replaces a parse over the evaluator's prose that anchored on the six item
 * names and a leading "fail". That parse decided whether a Round was spent, so
 * every phrasing it did not anticipate was a Round spent or saved by accident —
 * *"caveats: pass … so this does not fail"* had to be defended against in a
 * regular expression. A verdict the model **submits** cannot be mis-read,
 * because there is nothing to read: `strict: true` makes the shape impossible
 * to get wrong, and the six items are an enum rather than a heading.
 *
 * It is a `submit_*`, so invariant 7 makes it job-only: chat asks questions and
 * makes no record (SPEC §14.2).
 */
const submitEvaluation = defineTool({
  name: 'submit_evaluation',
  description:
    'Submit your review: a verdict for every rubric item, and a summary. Call it once, last — prose in your reply is not recorded, so a review that does not call this has produced nothing.',
  input: EVALUATION_PAYLOAD,
  surfaces: ['job'],
  effect: 'write',
  spends: [],
  latency: 'fast',
  handler: async (input) => ({ ok: true, data: input }),
});

/**
 * A closed enum, so **Discover adds a table and no new Citation target group**
 * (SPEC §11.1). No rationale sentence is written; the reasoning stays
 * inspectable in the Trace.
 */
const submitLeadClassification = defineTool({
  name: 'submit_lead_classification',
  description:
    'Classify this company into one closed category. "unclear" is a real answer and is often the right one.',
  input: z.object({
    classification: z.enum([
      'manufacturer',
      'forwarder_or_logistics',
      'trader_or_distributor',
      'consumer_goods',
      'unclear',
    ]),
    reasoning: z.string().describe('Recorded in the trace. No sentence is written from it.'),
  }),
  surfaces: ['job'],
  effect: 'write',
  spends: [],
  latency: 'fast',
  handler: async (input) => ({ ok: true, data: input }),
});

/**
 * The one write exposed over MCP, and the only `submit_*` that is not job-only.
 *
 * A Dossier is an `assessment` with `kind: 'dossier'`, not a table of its own.
 */
const submitDossier = defineTool({
  name: 'submit_dossier',
  description:
    'Submit an in-depth research write-up on one supplier. Cited like an assessment: every sentence carries a citation to a stored row.',
  input: z.object({ sentences: z.array(citedSentence).min(1) }),
  surfaces: ['mcp'],
  effect: 'write',
  spends: [],
  latency: 'fast',
  handler: async (input) => ({ ok: true, data: input }),
});

export const AGENT_WRITES = [
  submitMatchProposal,
  submitMatchVerdict,
  submitAssessment,
  submitRecommendation,
  submitEvaluation,
  submitLeadClassification,
  submitDossier,
];

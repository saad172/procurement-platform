import { z } from 'zod/v4';
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
export const submitMatchProposal = defineTool({
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
export const submitMatchVerdict = defineTool({
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

/** A sentence and the rows it cites. The pair is inseparable by construction. */
const citedSentence = z.object({
  section: z.enum([
    'identity',
    'compliance',
    'ownership',
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
  /**
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
   */
  citations: z
    .array(
      z.object({
        entityId: z
          .string()
          .optional()
          .describe('A Sayari entity id, as returned by sayari_get_entity or get_supplier. Not a uuid.'),
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
          .describe('The `id` from get_assessment_brief\'s criterionValueIds, or from get_supplier\'s criterionValues.'),
        matchId: z
          .string()
          .optional()
          .describe("The `matchId` from get_assessment_brief, or the match's `id` from get_supplier."),
        shortlist: z
          .object({
            programId: z
              .string()
              .describe("The program's `id` from get_program or get_shortlist — a uuid, never its name."),
            categoryId: z
              .string()
              .describe("The category's `id` — a uuid, never its code like 'HAR'."),
          })
          .optional()
          .describe('Both halves, for a claim about the shortlist itself rather than about one supplier.'),
      }),
    )
    .min(1)
    .describe(
      'At least one, each naming exactly one target. A sentence without a citation cannot be inserted, and an id in the wrong field is refused by the database.',
    ),
  pickSupplierId: z.string().optional().describe('Only in the conditions section'),
});

export const submitAssessment = defineTool({
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

export const submitRecommendation = defineTool({
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
 * A closed enum, so **Discover adds a table and no new Citation target group**
 * (SPEC §11.1). No rationale sentence is written; the reasoning stays
 * inspectable in the Trace.
 */
export const submitLeadClassification = defineTool({
  name: 'submit_lead_classification',
  description: 'Classify this company into one closed category. "unclear" is a real answer and is often the right one.',
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
export const submitDossier = defineTool({
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
  submitLeadClassification,
  submitDossier,
];

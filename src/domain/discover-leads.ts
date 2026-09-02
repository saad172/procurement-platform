import type * as t from '@/db/schema';
import type { RunLoopOutcome } from '@/model/types';

/**
 * The judgements Discover makes around the classifier call (SPEC §11).
 *
 * `discoverLeads` runs a model once per candidate, so the Job end to end
 * cannot run offline and has never had a test. Everything it decides *around*
 * that call is pure and lives here instead: which territories to ask about,
 * which rows to demote, how a Lead relates to a Supplier already on the
 * roster, and what to write down when the classifier produced no answer.
 *
 * None of this changes what the classifier is sent — the prompt is built in
 * `src/model/prompts/classifier.ts` from the trade row, and nothing here
 * touches it.
 */

// ── The Program's territories ────────────────────────────────────────────────

/**
 * The countries Discover asks about: **the Program's territories**, not a
 * constant.
 *
 * This was `[program?.importingCountry ?? 'USA', 'MEX']` — a hardcoded second
 * entry, which for a Program importing into Mexico asked for `['MEX', 'MEX']`.
 * The Program stores one importing country deliberately (`program.importing_country`
 * carries its own note: with a Mexican Plant it is an explicit *proxy* rather
 * than a fact), so the second territory is not missing data — it is the
 * Plants. P4 sits in Ramos Arizpe, and a shipment arriving for P4 arrives in
 * Mexico whatever the Program declares as its importer.
 *
 * The importing country leads because it is the Program's own declaration; the
 * Plants follow in their seeded order, deduped. For the founding Program that
 * is `['USA', 'MEX']`, which is what the constant said and what SPEC §11
 * records — the difference is that it is now derived from rows a person
 * authored rather than written into a query builder.
 */
export function programTerritories(
  program: { importingCountry: string } | undefined,
  plants: readonly { country: string }[],
): string[] {
  const countries = [program?.importingCountry, ...plants.map((plant) => plant.country)];
  return [...new Set(countries.filter((country): country is string => Boolean(country)))];
}

// ── The prefilter ────────────────────────────────────────────────────────────

/**
 * **Noise is the hard part**, and it has no rule.
 *
 * HS 8507.60 is *any* lithium-ion battery, not a traction pack, so the BAT line
 * into USA/MEX returns **14 560 counterparties** whose first page is led by
 * Apple, Amazon and a freight forwarder. The two rows that most need separating
 * are structurally identical: DAMCO CHINA LIMITED at 16 930 shipments and a
 * real component maker at a tenth of that differ in no field a filter can read.
 *
 * So the prefilter below is cheap and honest about what it cannot do, and the
 * classifier does the rest.
 *
 * **Measured** on the 100-row BAT page (`pnpm check:prefilter`), against
 * Sayari's own `logisticsEntity` flag as ground truth:
 *
 * | | count |
 * |---|---|
 * | rows Sayari flags as logistics | 14 |
 * | of those, caught by name | 9 |
 * | of those, missed by name | 5 |
 * | **manufacturers wrongly demoted** | **0** |
 *
 * Zero false positives is the property that matters. A heuristic that never
 * demotes a real manufacturer is safe to sort by even when it misses a third of
 * the forwarders — the misses survive to the classifier, which is where the
 * judgement was supposed to happen anyway. Had it had false positives, the
 * reorder would be quietly deciding the outcome, and the tests would fail
 * rather than the classifier catching it.
 */
const FORWARDER_MARKERS = [
  'logistics',
  'forwarding',
  'freight',
  'shipping',
  'transport',
  'express',
  'cargo',
  'customs',
  'broker',
  'warehous',
  'damco',
  'kuehne',
  'expeditors',
  'panalpina',
  'schenker',
  'agility',
  'ceva',
  'dsv',
  '3pl',
];

/** Cheap, and it only ever *reorders* — it never removes a row. */
export function prefilterScore(label: string): number {
  const name = label.toLowerCase();
  return FORWARDER_MARKERS.some((marker) => name.includes(marker)) ? -1 : 0;
}

// ── How a Lead relates to a Supplier already on the roster ───────────────────

/** One roster row, reduced to what the relation needs: who it is and its name. */
export type RosterSupplier = { supplierId: string; rosterName: string | null };

/**
 * The relation as it is **stored** on the Lead — `leadRelation()` in
 * `lead-answer.ts` is how it is said.
 */
export type LeadRelationDecision = {
  relatedSupplierId: string | null;
  relationVerified: boolean;
};

/**
 * Dedupe is exact entity-id plus an unverified name-token overlap flag, and
 * the Corporate family upgrades the second to the first (SPEC §11.2).
 *
 * Both halves were computed and then thrown away: `nameFlag` ended at
 * `void nameFlag` and `relatedSupplierId` was written as a literal `null`, so
 * `leadRelation` could never reach its unverified branch and the *possibly
 * related · name match, unverified* badge could not render at all. The
 * verified branch could render, off a `family_member` map built with **no
 * `WHERE`** — any Program's ownership graph — and with no Supplier named.
 *
 * `familyOwners` is that map, scoped by the caller to Family members of this
 * Program's accepted Profiles: a Lead in it is *related by ownership,
 * verified*, because Sayari's ownership graph put it there. A name token is
 * never an upgrade to verified; it is a question, labelled as one.
 */
export function decideLeadRelation(
  candidate: { entityId: string; label: string },
  args: {
    /** Family member entity id → the Supplier of this Program whose family holds it. */
    familyOwners: ReadonlyMap<string, string>;
    roster: readonly RosterSupplier[];
  },
): LeadRelationDecision {
  const owner = args.familyOwners.get(candidate.entityId);
  if (owner) return { relatedSupplierId: owner, relationVerified: true };

  const names = args.roster
    .map((supplier) => supplier.rosterName)
    .filter((name): name is string => name != null);
  const matched = sharesNameToken(candidate.label, names);
  if (!matched) return { relatedSupplierId: null, relationVerified: false };

  // The Supplier behind the name, so the badge can say *which* company this
  // might be related to rather than that it might be related to something.
  const supplier = args.roster.find((row) => row.rosterName === matched);
  return { relatedSupplierId: supplier?.supplierId ?? null, relationVerified: false };
}

/**
 * The unverified name-token overlap flag (SPEC §11.2).
 *
 * Roster Suppliers appear in trade data as their foreign subsidiaries, and
 * `traversal.ubo` returns nothing, so entity-id dedupe alone would propose a
 * company already on the list under a different id. This catches those — and
 * it is **labelled, never hidden**, because an unverified relationship
 * presented as fact is worse than one presented as a question.
 */
export function sharesNameToken(label: string, rosterNames: readonly string[]): string | null {
  const tokens = new Set(
    label
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 3),
  );
  for (const name of rosterNames) {
    const nameTokens = name
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 3);
    if (nameTokens.some((token) => tokens.has(token))) return name;
  }
  return null;
}

// ── What the classifier answered, or why it did not ──────────────────────────

const CLASSIFICATIONS = [
  'manufacturer',
  'forwarder_or_logistics',
  'trader_or_distributor',
  'consumer_goods',
  'unclear',
] as const satisfies readonly (typeof t.leadClassification.enumValues)[number][];

/**
 * A classification, or the reason there is none.
 *
 * **`unclear` is a real answer and is often the right one**, which is exactly
 * why a failure may not be written as `unclear`: a person reviewing Leads can
 * act on *the model looked at this and could not tell*, and cannot act on the
 * same words when what happened is that the loop hit a cap.
 */
export type LeadClassificationOutcome = {
  classification: (typeof CLASSIFICATIONS)[number] | null;
  reasoning: string | null;
  /** Null when a classification was submitted; a sentence when it was not. */
  notClassifiedReason: string | null;
};

/**
 * Reads the submission out of the loop's outcome, or says what happened
 * instead.
 *
 * This was `submitted?.classification ?? 'unclear'`, so a terminated loop, a
 * failed one and a model that answered *unclear* were the same row.
 *
 * A `terminated` outcome carries its `toolUses` for a documented reason —
 * "a ceiling firing one turn after the model submitted its answer used to
 * discard that answer" (`RunLoopOutcome`) — so a submission is read from it
 * too, and the cap is only reported when there is genuinely nothing to read.
 * The enum is re-checked here because `toolUses` carries the model's **raw**
 * input, which the tool's own zod schema never saw.
 *
 * **The LAST submission, not the first**, for the reason `readSubmission` in
 * `src/jobs/submission.ts` settles the drafting loops on the same one: the SDK
 * parses a tool's input before running it, a zod failure there is handed back
 * to the model as an `is_error` result, and the sensible model then submits
 * again with the field fixed. `find` returned the payload that had already
 * been rejected. This reads the same way that helper does, in the domain,
 * because deciding what a Lead row says has to stay pure — `readSubmission`
 * reaches the tool registry, and nothing under `src/domain` imports the jobs
 * layer.
 */
export function readLeadClassification(outcome: RunLoopOutcome): LeadClassificationOutcome {
  const notClassified = (reason: string): LeadClassificationOutcome => ({
    classification: null,
    reasoning: null,
    notClassifiedReason: reason,
  });

  if (outcome.status === 'failed') return notClassified(`the classifier failed: ${outcome.error}`);
  if (outcome.status === 'paused_on_budget') {
    return notClassified('the run reached its budget before this lead was classified');
  }

  const submitted = outcome.toolUses.findLast((use) => use.name === 'submit_lead_classification')
    ?.input as { classification?: unknown; reasoning?: unknown } | undefined;
  const classification = CLASSIFICATIONS.find((value) => value === submitted?.classification);

  if (!classification) {
    if (outcome.status === 'terminated') {
      return notClassified(`the classifier loop stopped: ${outcome.reason}`);
    }
    return notClassified(
      submitted
        ? 'the classifier submitted a category outside the closed enum'
        : 'the classifier finished without submitting a classification',
    );
  }

  return {
    classification,
    reasoning: typeof submitted?.reasoning === 'string' ? submitted.reasoning : null,
    notClassifiedReason: null,
  };
}

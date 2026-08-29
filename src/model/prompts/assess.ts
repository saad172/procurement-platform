import { MAX_ROUNDS } from '@/config/constants';

/**
 * The Assessment loop: proposer → evaluator (SPEC §10).
 *
 * One per Supplier × Program, **never per Category**, though it carries a Score
 * for each Category that Supplier bids on.
 */

const CITATION_RULE = `THE CITATION RULE, WHICH IS NOT NEGOTIABLE
Every sentence you write carries at least one citation to a stored row: an
entity, a record, an enrichment, a criterion value, a match, or a shortlist.
A sentence without one cannot be inserted — the constraint is in the database,
not in a later review — so an uncited sentence is not a rejected sentence, it is
a failed submission.

You may not cite another sentence, and you may not cite an Assessment or a
Recommendation. A citation points at evidence, not at prose.

Every number you write must be traceable to a frozen input or to a cited row,
matched at the precision you wrote it. Do not paraphrase a figure: "roughly
800 km" matches nothing, while "824 km" matches the row it came from.`;

export const proposerSystem = `You write an evaluation of one supplier for one sourcing programme.

${CITATION_RULE}

SECTIONS
  identity     always, and always first — which company this is, and how it was settled
  compliance   whenever the compliance criterion returned a value
  ownership    whenever the ownership criterion returned a value
  country      whenever the country criterion returned a value
  tariff       ONLY when the supplier has at least one category
  media        whenever the media criterion returned a value
  limits       always, and never empty
  dissent      never written by you — it is assembled from unresolved objections

WHAT THE limits SECTION IS FOR
It names every criterion that returned unknown and why, the data-confidence
band, and every mandatory caveat. It is the section that stops the rest of the
document reading as more certain than it is, so it is the one section that may
never be empty.

THE VERDICT
A closed choice: recommend, recommend with conditions, do not shortlist, or
escalate. It is an enum, not a claim, which is the only reason it needs no
citation. Where a disqualifying badge is lit, the verdict must be "do not
shortlist" or "escalate" — which of the two is your judgement, and the code will
not make it for you.

WHAT YOU DO NOT WRITE
A confidence figure. The data-confidence badge and the limits section carry that,
and an authored confidence would be exactly the uncited number this whole design
refuses.`;

export const evaluatorSystem = `You review a draft evaluation against the evidence it was written from.

You are seeing exactly what the writer saw: the brief, the frozen inputs, the
draft, and this rubric. You are not seeing your own earlier objections or any
reply to them. Judging an argument against evidence its author never had produces
objections nobody can act on.

THE RUBRIC — six items, each pass, fail or can't-tell, one line each

  support           the cited row is real and resolvable, but does not carry the claim
  strength          a claim beyond the record — "sanctioned parent" where the company is state-owned
  number fidelity   a figure not traceable to a frozen input or a cited row
  caveats           a mandatory line is missing — the tariff caveat, the jurisdiction line,
                    an unknown criterion unnamed in limits
  eligibility       a supplier ranked or picked without an accepted match; a cross-category claim
  omission          a material fact IN THE BRIEF that the draft ignores. This is the one item
                    that attaches to a section rather than to a sentence, and it is scoped to
                    the brief because that is what the writer had

Objections that survive ${MAX_ROUNDS} rounds are published as dissent rather than
silently dropped. A run must complete, so failing to converge is a recorded
disagreement, not an error.`;

export type AssessInput = {
  supplierName: string;
  programName: string;
  roundN: number;
  brief: string;
  frozenInputs: string;
  objections?: string[] | undefined;
};

export function buildFirstUserMessage(input: AssessInput): string {
  const lines = [
    `SUPPLIER: ${input.supplierName}`,
    `PROGRAMME: ${input.programName}`,
    `Round ${input.roundN} of ${MAX_ROUNDS}.`,
    '',
    'THE BRIEF',
    input.brief,
    '',
    'FROZEN INPUTS',
    input.frozenInputs,
  ];
  if (input.objections?.length) {
    lines.push('', 'OBJECTIONS TO ANSWER', ...input.objections.map((o) => `  - ${o}`));
  }
  return lines.join('\n');
}

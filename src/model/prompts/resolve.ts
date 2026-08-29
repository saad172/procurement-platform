import { IDENTITY_STANDARD, IDENTITY_TRAPS, MAX_ROUNDS } from '@/config/constants';

/**
 * The Match loop's two agents (SPEC §6).
 *
 * The resolver carries memory across Rounds; **the evaluator is blind and
 * stateless** — it never sees the resolver's pick, its prose, or any earlier
 * Round. Agreement is *our code comparing two entity ids*, not either agent
 * saying so, which is why neither prompt asks for agreement.
 */

export const resolverSystem = `You resolve a row from a supplier roster to one company in the Sayari entity graph.

THE IDENTITY STANDARD
${IDENTITY_STANDARD}

KNOWN TRAPS
${IDENTITY_TRAPS.map((t) => `- ${t}`).join('\n')}

WHAT COUNTS AS EVIDENCE
Only Sayari and GLEIF. Your own knowledge of the world may suggest a query term —
a rename, a legal-form variant, a local-language name — and the tool call records
why you tried it. But a rename counts as a FACT only once Sayari's own alias or
possibly_same_as data confirms it. You may not conclude anything from what you
already know about a company.

HOW A ROUND WORKS
You propose one candidate, or none. An independent evaluator that has never seen
your reasoning proposes one from the same evidence. Our code compares the two
entity ids. If they differ you get the objection and another Round, up to ${MAX_ROUNDS}.
You are not being asked to agree with anyone; you are being asked to be right.

WHAT YOU RETURN
A structured proposal: one entity id or none, a verdict for every one of the eight
Discriminators with one line of reasoning each, and a confidence. Never prose.
"Can't tell" is a real verdict and is not the same as "failed" — use it when the
evidence is absent rather than contrary.

HOW YOU FINISH — THIS IS THE ONLY WAY TO RECORD ANYTHING
Search as much as you need, then call submit_match_proposal. Prose in your reply
is not recorded: a proposal exists only when that tool runs.

THE ONE THING THAT MATTERS MOST
The top hit is frequently the wrong company. A divested business keeps its old
name in alias data; an investment arm sits at the parent's exact address; a
group's manufacturing subsidiary outranks the group itself on a name search.
Accepting a top hit produces a confident, sourced, wrong answer, which is worse
than saying you could not settle it.`;

export const evaluatorSystem = `You choose which company in the Sayari entity graph a supplier roster row refers to.

THE IDENTITY STANDARD
${IDENTITY_STANDARD}

KNOWN TRAPS
${IDENTITY_TRAPS.map((t) => `- ${t}`).join('\n')}

WHAT YOU ARE SEEING
The roster row, and every candidate found so far, shuffled. You are not seeing
anyone else's pick, anyone else's reasoning, or any earlier round of this
conversation. That is deliberate: you are a second opinion, and a second opinion
that has read the first is not one.

WHAT COUNTS AS EVIDENCE
Only what is in front of you. Your own knowledge of a company may not settle
which record is the right one.

WHAT YOU RETURN
One entity id or none, a verdict for every one of the eight Discriminators with
one line of reasoning each, and a confidence. Never prose. "Can't tell" is a real
verdict and is not the same as "failed".

HOW YOU FINISH — THIS IS THE ONLY WAY TO RECORD ANYTHING
Call submit_match_verdict. Prose in your reply is not recorded.

You may contradict a verdict you would have given on different evidence. That is
correct: it means the evidence changed, not that you are unstable.`;

export type ResolveInput = {
  rosterName: string;
  rosterAddress: string | null;
  rosterCountry: string | null;
  roundN: number;
  objection?: string | undefined;
  candidateSummaries: string[];
};

export function buildFirstUserMessage(input: ResolveInput): string {
  const lines = [
    'ROSTER ROW',
    `  name:    ${input.rosterName}`,
    `  address: ${input.rosterAddress ?? '(none)'}`,
    `  country: ${input.rosterCountry ?? '(none)'}`,
    '',
    `Round ${input.roundN} of ${MAX_ROUNDS}.`,
  ];
  if (input.objection) {
    lines.push('', 'THE OBJECTION FROM THE LAST ROUND', `  ${input.objection}`);
  }
  if (input.candidateSummaries.length > 0) {
    lines.push('', 'CANDIDATES SO FAR', ...input.candidateSummaries.map((c) => `  ${c}`));
  }
  return lines.join('\n');
}

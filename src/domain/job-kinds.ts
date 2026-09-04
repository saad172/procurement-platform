/**
 * What a Job kind is called, and what it does, in words rather than in enum.
 *
 * A Run page is read to answer *what did this cost and why*, and `traverse` is
 * the kind that answers it worst on its own: it is a column value, not a word
 * anybody uses, and CONTEXT has a name for the thing — a **Deep Traversal**.
 * The enum stays `traverse` because that is the Job kind the queue, the caps
 * table and `enqueue_deep_traversal` all agree on; what changes is that no page
 * prints it raw.
 *
 * Two functions rather than one, because two surfaces are asking different
 * questions. A table cell has room for a name and a heading has room for a
 * sentence, and a cell that carried the sentence would push six other columns
 * off the screen.
 *
 * Kept in `domain` rather than beside a page: the Run page, the phase strip and
 * the Trace page all name the same kinds, and three copies of a label is how
 * two of them come to disagree.
 */

/** The short name a table cell and a phase bar carry. */
const LABELS: Record<string, string> = {
  resolve: 'resolve',
  enrich: 'enrich',
  fetch_entity: 'fetch record',
  traverse: 'Deep Traversal',
  assess: 'assess',
  recommend: 'recommend',
  discover: 'Discover',
  dossier: 'Dossier',
  pairs: 'Check every pair',
  trade: 'Trade',
};

/**
 * One sentence saying what the Job is for.
 *
 * Written for somebody looking at a Trace and asking *what was this supposed to
 * do* — so each names its unit of work, and the two deterministic kinds say
 * they run no model, because an empty Trace otherwise reads as a Job that
 * failed before it started.
 */
const SENTENCES: Record<string, string> = {
  resolve: 'Settles one Supplier’s Match against the Sayari graph, through the rung ladder.',
  enrich:
    'Fetches the six sources for one accepted Profile and rewrites its Criterion values. It runs no model, so its Trace is its upstream calls.',
  fetch_entity:
    'Fetches one company’s own record, so its facts are cited to it rather than copied out of another company’s payload. It runs no model.',
  traverse:
    'Extends a Profile beyond the automatic ownership read — downward through subsidiaries and upward through owners, within a hop and node cap — and records what it reaches as Family members. It runs no model.',
  assess: 'Writes and reviews one Supplier’s Assessment, ending in a verdict from a closed set.',
  recommend:
    'Argues which Supplier one Category should go with, and under what conditions, from the Shortlist.',
  discover: 'Searches trade data for companies on no imported list, and classifies what it finds.',
  dossier: 'An opt-in research write-up on one Supplier, by an agent that chooses what to look at.',
  pairs:
    'Runs the shortest-path check for every accepted-Supplier pair bidding one Category, so a Concentration stored Networks cannot see still turns up. It runs no model.',
  trade:
    'Fetches one Profile’s trade footprint, its buyers, a dated shipment sample, and its upstream supply-chain tiers. It runs no model.',
};

/** Falls back to the raw kind, because an unnamed kind is better than nothing. */
export function jobKindLabel(kind: string): string {
  return LABELS[kind] ?? kind;
}

/** Empty for a kind nobody has written a sentence for, so the page renders none. */
export function jobKindSentence(kind: string): string {
  return SENTENCES[kind] ?? '';
}

import type { FrozenInputs } from './staleness';

/**
 * The version diff (SPEC §10.6).
 *
 * **A pure function computed on demand, never stored**, in three parts and in
 * this order:
 *
 * 1. **`frozen_inputs`** — first, **because it is the cause**. Everything below
 *    is what the moved numbers did.
 * 2. **picks** — by Supplier, as a role change.
 * 3. **sentences** — aligned on `(section, sorted citation-target set)`, with
 *    text similarity only as a tiebreak.
 *
 * Aligning on the **citation set** rather than on position or text is what
 * makes the diff meaningful: two versions of "the same claim about the same
 * evidence" line up even when the wording changed completely, which is exactly
 * the case a reader wants to see.
 *
 * **A re-run always versions, even when the text is identical**, because *"the
 * weights changed and the argument didn't"* is the most interesting thing the
 * diff can say.
 */

export type DiffSentence = {
  section: string;
  text: string;
  /** The citation targets, as opaque keys. Sorted before comparison. */
  citationKeys: string[];
};

export type DiffPick = { supplierId: string; supplierName: string; role: string; rank: number };

export type VersionDiff = {
  inputsChanged: { path: string; from: unknown; to: unknown }[];
  picks: {
    supplierId: string;
    supplierName: string;
    change: 'added' | 'removed' | 'role_changed' | 'rank_changed';
    from?: { role: string; rank: number } | undefined;
    to?: { role: string; rank: number } | undefined;
  }[];
  sentences: {
    section: string;
    change: 'added' | 'removed' | 'reworded' | 'unchanged';
    from?: string | undefined;
    to?: string | undefined;
  }[];
  /**
   * True when nothing at all differs. Worth surfacing rather than hiding: a
   * re-run that changed nothing is a result, and the confirm gate warns that it
   * may happen.
   */
  empty: boolean;
};

/** The alignment key: same section, same evidence. */
const alignmentKey = (sentence: DiffSentence): string =>
  `${sentence.section}::${[...sentence.citationKeys].sort().join('|')}`;

export function diffVersions(args: {
  before: { frozen: FrozenInputs; picks: DiffPick[]; sentences: DiffSentence[] };
  after: { frozen: FrozenInputs; picks: DiffPick[]; sentences: DiffSentence[] };
}): VersionDiff {
  const inputsChanged = diffFrozen(args.before.frozen, args.after.frozen);
  const picks = diffPicks(args.before.picks, args.after.picks);
  const sentences = diffSentences(args.before.sentences, args.after.sentences);

  return {
    inputsChanged,
    picks,
    sentences,
    empty:
      inputsChanged.length === 0 &&
      picks.length === 0 &&
      sentences.every((s) => s.change === 'unchanged'),
  };
}

function flatten(inputs: FrozenInputs): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [key, value] of Object.entries(inputs.weights)) out.set(`weights.${key}`, value);
  for (const [key, value] of Object.entries(inputs.criterionValues))
    out.set(`criterionValues.${key}`, value);
  for (const [key, value] of Object.entries(inputs.scores)) out.set(`scores.${key}`, value);
  out.set('shortlistOrder', inputs.shortlistOrder.join('|'));
  for (const [key, value] of Object.entries(inputs.supplierVerdicts)) {
    out.set(`verdicts.${key}.verdict`, value.verdict);
    out.set(`verdicts.${key}.evaluatorOutcome`, value.evaluatorOutcome);
  }
  return out;
}

function diffFrozen(before: FrozenInputs, after: FrozenInputs) {
  const a = flatten(before);
  const b = flatten(after);
  const changes: { path: string; from: unknown; to: unknown }[] = [];
  for (const [path, from] of a) {
    const to = b.get(path);
    if (JSON.stringify(from) !== JSON.stringify(to)) changes.push({ path, from, to });
  }
  for (const [path, to] of b) {
    if (!a.has(path)) changes.push({ path, from: undefined, to });
  }
  return changes;
}

/** By Supplier, as a role change — not as a list reordering. */
function diffPicks(before: readonly DiffPick[], after: readonly DiffPick[]): VersionDiff['picks'] {
  const byId = (picks: readonly DiffPick[]) => new Map(picks.map((p) => [p.supplierId, p]));
  const a = byId(before);
  const b = byId(after);
  const out: VersionDiff['picks'] = [];

  for (const [id, pick] of a) {
    const next = b.get(id);
    if (!next) {
      out.push({
        supplierId: id,
        supplierName: pick.supplierName,
        change: 'removed',
        from: { role: pick.role, rank: pick.rank },
      });
      continue;
    }
    if (next.role !== pick.role) {
      out.push({
        supplierId: id,
        supplierName: pick.supplierName,
        change: 'role_changed',
        from: { role: pick.role, rank: pick.rank },
        to: { role: next.role, rank: next.rank },
      });
    } else if (next.rank !== pick.rank) {
      out.push({
        supplierId: id,
        supplierName: pick.supplierName,
        change: 'rank_changed',
        from: { role: pick.role, rank: pick.rank },
        to: { role: next.role, rank: next.rank },
      });
    }
  }
  for (const [id, pick] of b) {
    if (!a.has(id)) {
      out.push({
        supplierId: id,
        supplierName: pick.supplierName,
        change: 'added',
        to: { role: pick.role, rank: pick.rank },
      });
    }
  }
  return out;
}

function diffSentences(
  before: readonly DiffSentence[],
  after: readonly DiffSentence[],
): VersionDiff['sentences'] {
  const remaining = [...after];
  const out: VersionDiff['sentences'] = [];

  for (const sentence of before) {
    const key = alignmentKey(sentence);
    let index = remaining.findIndex((candidate) => alignmentKey(candidate) === key);

    // Text similarity is the TIEBREAK, not the alignment: two sentences about
    // the same evidence in the same section are the same claim, however
    // differently worded.
    if (index === -1) {
      index = remaining.findIndex(
        (candidate) =>
          candidate.section === sentence.section && similarity(candidate.text, sentence.text) > 0.6,
      );
    }

    if (index === -1) {
      out.push({ section: sentence.section, change: 'removed', from: sentence.text });
      continue;
    }
    const match = remaining.splice(index, 1)[0]!;
    out.push({
      section: sentence.section,
      change: match.text === sentence.text ? 'unchanged' : 'reworded',
      from: sentence.text,
      to: match.text,
    });
  }

  for (const sentence of remaining) {
    out.push({ section: sentence.section, change: 'added', to: sentence.text });
  }
  return out;
}

/** Token overlap, which is enough for a tiebreak and needs no dependency. */
function similarity(a: string, b: string): number {
  const tokensOf = (text: string) => new Set(text.toLowerCase().split(/\W+/).filter(Boolean));
  const left = tokensOf(a);
  const right = tokensOf(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / Math.max(left.size, right.size);
}

/**
 * *Why* a version was written is **derived, never stored** (SPEC §12.5):
 * `version → round → job_round → job → run` yields *"re-ran after traversing
 * Yazaki"* with no new column.
 */
export function describeWhyWritten(
  run: { trigger: string; subjectLabel: string | null } | undefined,
): string {
  if (!run) return 'Written by the original run.';
  switch (run.trigger) {
    case 'full':
      return 'Written by a full run of the program.';
    case 'traverse':
      return `Re-ran after ${run.subjectLabel ?? 'a deep traversal'}.`;
    case 'settlement':
      return `Re-ran after ${run.subjectLabel ?? 'a match was settled'}.`;
    case 'reassess':
      return `Re-ran after ${run.subjectLabel ?? 're-assessment'}.`;
    case 'rerun_recommendation':
      return 'Re-ran on request.';
    case 'thread':
      return 'Re-ran from a chat request.';
    default:
      return `Written by a ${run.trigger} run.`;
  }
}

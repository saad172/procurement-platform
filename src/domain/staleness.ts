import { createHash } from 'node:crypto';

/**
 * Staleness (SPEC §12), beside `score.ts` and pure like it. **Never stored.**
 *
 * The fact the whole design turns on: **a Deep Traversal changes no number.**
 * Ownership exposure scores *current one-hop edges*, and shared ownership is a
 * Shortlist finding rather than a Criterion input — so a hop-2 or hop-3 edge
 * moves nothing in `frozen_inputs`. A staleness rule keyed on numbers would be
 * blind to the exact case it exists for. The traversal is therefore **the case
 * that proves the rule, not an exception to it**, and one rule covers all six
 * sources.
 *
 * **Nothing runs on arrival.** Evidence *marks*; only a person or confirm-gated
 * chat re-runs. A re-run always versions and always spends, and an automatic
 * one would supersede an *accepted* version with no human act. Doing nothing
 * was rejected on the other side: a document arguing from a graph that has
 * since changed, unmarked, is the silent-falsehood failure this app is built
 * against.
 */

/**
 * What a version froze when it was written (SPEC §10.6).
 *
 * The verdicts are in here for a reason that took a round to find: a Supplier
 * re-assessed into `do_not_shortlist` was invisible to **both** signals — its
 * verdict was in no frozen input, and a Recommendation may not cite an
 * Assessment. Widening `frozen_inputs` closes that inside the existing
 * comparison rather than with a third indicator.
 */
export type FrozenInputs = {
  /**
   * **The vector the Scores were computed with**, not the stored rows.
   *
   * A Program saves only the weights it has changed, and `score.ts` fills the
   * rest from `DEFAULT_WEIGHTS` — so the stored rows are not a weight vector,
   * they are a diff against one. Freezing the diff meant freezing a set of
   * numbers that could not reproduce the Scores frozen beside them, and
   * comparing it here answered "did the saved rows move" rather than "was this
   * argument made under different weights".
   */
  effectiveWeights: Record<string, number>;
  criterionValues: Record<string, number | null>;
  scores: Record<string, number | null>;
  /**
   * The ranked Supplier ids of each Category, **in Shortlist order**, keyed by
   * Category — because a Shortlist is per Category and the same Supplier holds
   * a different rank in each one it bids on.
   */
  shortlistOrder: Record<string, string[]>;
  /** `${supplierId}:${categoryId}` → the rank it held, or null where it reached none. */
  shortlistRanks: Record<string, number | null>;
  supplierVerdicts: Record<string, { verdict: string | null; evaluatorOutcome: string }>;
  /**
   * The roster row each Supplier was imported as.
   *
   * **An Assessment's identity section is about the roster row**, so the roster
   * row is one of its inputs by definition — and it was missing. A sentence
   * opening *"Roster row 12, «Yazaki», registered at …"* was rejected in every
   * Round because `12` appeared nowhere the number check could see, and the
   * roster index is a figure the app itself assigned.
   *
   * It belongs in the frozen inputs rather than merely in a cited row for the
   * same reason the weights do: a re-import that renumbered the roster would
   * change what the Assessment was written about, and the staleness hash should
   * notice.
   */
  rosterRows: Record<
    string,
    { index: number | null; name: string | null; address: string | null; country: string | null }
  >;
  /**
   * The tariff flags on every Category these Suppliers bid in.
   *
   * Finding 67 put them on the Tariff criterion, which made them citable by a
   * sentence *about the rate*. It was not enough: a headline naming Section 232
   * cites the shortlist, not the criterion, and the check saw nothing again.
   *
   * Frozen inputs are candidates for **every** sentence regardless of what it
   * cites, which is the right home for text the app shows and any sentence may
   * quote. They belong in the frozen set on their own merits too — a flag added
   * to a Category changes what the Recommendation was written against, and the
   * staleness hash should notice.
   */
  tariffFlags: { categoryId: string; key: string; label: string; whyNotARate: string | null }[];
};

/** A citable row, for the *new evidence* residual. */
export type CitableRow = {
  /**
   * **Attachment is by subject, not row id.** A refreshed tariff writes a *new*
   * `enrichment` row for the same HS line, and a rule keyed on row id would
   * call that new evidence about nothing.
   */
  subjectKey: string;
  kind: string;
  firstSeenAt: Date;
  rowId: string;
};

export type StalenessIndicators = {
  /**
   * *The numbers behind this argument moved.* Recomputes `frozen_inputs` and
   * compares. This is the version-diff's first half, and it is the **cause**.
   */
  inputsMoved: {
    lit: boolean;
    changes: { path: string; from: unknown; to: unknown }[];
  };
  /**
   * *Something arrived that changes no number.* The one genuinely new signal.
   *
   * Computed as the **residual after inputs-moved**, so the two are disjoint
   * **by construction rather than by rule**, and a change that moves a number
   * lights only the causal indicator.
   *
   * It **names what arrived** — count, kind, and the rows — because a dismissal
   * a person cannot see the grounds for is not a judgement.
   */
  newEvidence: {
    lit: boolean;
    rows: CitableRow[];
    byKind: Record<string, number>;
  };
};

/** A dismissal is a watermark, not a boolean (SPEC §12.4). */
export type DismissalWatermark = {
  /** The moment it dismissed to. A later row re-lights the chip. */
  dismissedTo: Date;
  /** The `frozen_inputs` hash it dismissed against. A different delta re-lights. */
  dismissedInputsHash: string;
};

/** Stable hash of a frozen-input set, for the dismissal watermark. */
export function hashFrozenInputs(inputs: FrozenInputs): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([k, v]) => [k, canonical(v)]),
      );
    }
    return value;
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical(inputs)))
    .digest('hex');
}

/** Flattens one level of the frozen inputs into comparable paths. */
function flatten(inputs: FrozenInputs): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [key, value] of Object.entries(inputs.effectiveWeights))
    out.set(`effectiveWeights.${key}`, value);
  for (const [key, value] of Object.entries(inputs.criterionValues))
    out.set(`criterionValues.${key}`, value);
  for (const [key, value] of Object.entries(inputs.scores)) out.set(`scores.${key}`, value);
  // Per Category, so a re-rank inside one Category names that Category rather
  // than reporting that "the shortlist order" moved.
  for (const [categoryId, order] of Object.entries(inputs.shortlistOrder))
    out.set(`shortlistOrder.${categoryId}`, order.join('|'));
  for (const [key, rank] of Object.entries(inputs.shortlistRanks))
    out.set(`shortlistRanks.${key}`, rank);
  for (const [key, value] of Object.entries(inputs.supplierVerdicts)) {
    out.set(`verdicts.${key}.verdict`, value.verdict);
    out.set(`verdicts.${key}.evaluatorOutcome`, value.evaluatorOutcome);
  }
  return out;
}

/** Which subjects a version's Citations point at, for the residual. */
export type CitedSubjects = Set<string>;

/**
 * Computes both indicators for one version.
 *
 * The order is the design: **inputs-moved first, then new evidence as the
 * residual**. Computing them independently would let one row light both chips,
 * and a person would have to work out which one to believe.
 */
export function computeStaleness(args: {
  frozenAt: Date;
  frozen: FrozenInputs;
  current: FrozenInputs;
  /** Every citable row first seen since the version was written. */
  candidateRows: readonly CitableRow[];
  /** The subjects this version's Citations point at. */
  citedSubjects: CitedSubjects;
  dismissal?: DismissalWatermark | undefined;
}): StalenessIndicators {
  const before = flatten(args.frozen);
  const after = flatten(args.current);

  const changes: { path: string; from: unknown; to: unknown }[] = [];
  for (const [path, frozenValue] of before) {
    const currentValue = after.get(path);
    if (JSON.stringify(frozenValue) !== JSON.stringify(currentValue)) {
      changes.push({ path, from: frozenValue, to: currentValue });
    }
  }
  for (const [path, currentValue] of after) {
    if (!before.has(path)) changes.push({ path, from: undefined, to: currentValue });
  }

  // Every subject a moved number is *about*. A row attaching to one of these
  // has already been accounted for by the inputs-moved banner, so it is not
  // also new evidence — that is the "residual" and it is what keeps the two
  // disjoint by construction.
  const subjectsExplainedByChanges = new Set<string>();
  for (const change of changes) {
    const subject = change.path.split('.')[1];
    if (subject) subjectsExplainedByChanges.add(subject);
  }

  const arrived = args.candidateRows.filter(
    (row) =>
      row.firstSeenAt > args.frozenAt &&
      args.citedSubjects.has(row.subjectKey) &&
      !subjectsExplainedByChanges.has(row.subjectKey),
  );

  // The watermark: a dismissal silences rows up to a moment and an inputs delta
  // it was taken against. A LATER, DIFFERENT row or delta re-lights, so a
  // dismissal never silently mutes something it did not see.
  const currentHash = hashFrozenInputs(args.current);
  const inputsDismissed =
    args.dismissal != null && args.dismissal.dismissedInputsHash === currentHash;
  const evidenceAfterWatermark = args.dismissal
    ? arrived.filter((row) => row.firstSeenAt > args.dismissal!.dismissedTo)
    : arrived;

  const byKind: Record<string, number> = {};
  for (const row of evidenceAfterWatermark) byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;

  return {
    inputsMoved: { lit: changes.length > 0 && !inputsDismissed, changes },
    newEvidence: {
      lit: evidenceAfterWatermark.length > 0,
      rows: evidenceAfterWatermark,
      byKind,
    },
  };
}

/**
 * The transient *viewing a what-if* chip (SPEC §12.3).
 *
 * The third indicator, and the only one that is not about a version: it
 * compares the rail to the **Program default** and never reacts to a version at
 * all. Keeping it separate is what stops a live rail reintroducing the
 * permanently-lit failure the banner was fixed for.
 */
export function isViewingWhatIf(
  active: Record<string, number>,
  programDefault: Record<string, number>,
): boolean {
  const keys = new Set([...Object.keys(active), ...Object.keys(programDefault)]);
  for (const key of keys) {
    if ((active[key] ?? 0) !== (programDefault[key] ?? 0)) return true;
  }
  return false;
}

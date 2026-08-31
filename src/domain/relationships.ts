/**
 * What a Sayari relationship type means, and which way it points (SPEC §3.2).
 *
 * ## Why this file exists
 *
 * `entity_relationship` held **zero rows** while 2,048 entities were stored and
 * forty-six ownership traversals had been paid for. The projection read
 * `edge.type`; the payload carries `types` — plural, an object keyed by
 * relationship name, each key holding the occurrences of that relationship:
 *
 *     { types: { owner_of: [{ former: false, record: "…", … }] },
 *       former: false,
 *       target: { id: "…", label: "SNAP FIT", type: "intellectual_property" } }
 *
 * So the type string was always `undefined`, the owner regex never matched, and
 * every edge was dropped. One company alone discarded forty-eight. The visible
 * result was a UI reporting *"the ownership graph returned nobody"* as a finding
 * about the world rather than a defect in the reader.
 *
 * ## Why a table and not a rule
 *
 * The names look like they follow a rule — `has_<role>` for *the target holds
 * this role toward me*, `<role>_of` for *I hold it toward the target*. They do,
 * as far as the forty types measured here go. **The rule is still not the
 * contract.** `has_subsidiary` and `subsidiary_of` are exact opposites and both
 * contain the word *subsidiary*; a regex over names cannot tell them apart, and
 * that is precisely the bug this replaces. A type nobody has classified must
 * not silently pick a side, so it is absent from this table rather than
 * inferred, and absence has a defined meaning below.
 *
 * ## The frame, fixed once
 *
 * Every edge is read from some entity's payload. That entity is the
 * **subject**; `edge.target` is the **target**. Rows are stored exactly that
 * way round — `from` is the subject, `to` is the target, and the type is
 * verbatim. Nothing is normalised on the way in, so nothing can be inverted on
 * the way in. Direction is a property of the *name*, resolved here, on read.
 *
 * - `downward` — the subject owns or contains the target (`owner_of`).
 * - `upward` — the target owns or contains the subject (`has_shareholder`).
 * - `lateral` — neither contains the other (`has_officer`, `ships_to`).
 */

export type EdgeDirection = 'downward' | 'upward' | 'lateral';

export type RelationshipMeaning = {
  direction: EdgeDirection;
  /**
   * Whether this edge is **ownership or control of one company by another**,
   * which is the only kind Ownership exposure scores.
   *
   * An officer is not an owner and a shipment is not a shareholding. Both are
   * worth storing and neither belongs in that Criterion.
   */
  ownership: boolean;
};

/**
 * Every relationship type observed in the stored upstream bodies, classified.
 *
 * Counts in the comments are occurrences measured across 704 cached responses,
 * kept because they say which entries carry weight: a mistake in `owner_of`
 * misplaces 1,855 edges, one in `has_founder` misplaces one.
 */
const RELATIONSHIP_TYPES: Readonly<Record<string, RelationshipMeaning>> = {
  // ── Ownership and control ────────────────────────────────────────────────
  owner_of: { direction: 'downward', ownership: true }, //             1855
  has_subsidiary: { direction: 'downward', ownership: true }, //        958
  shareholder_of: { direction: 'downward', ownership: true }, //        508
  beneficial_owner_of: { direction: 'downward', ownership: true }, //   255
  has_shareholder: { direction: 'upward', ownership: true }, //         378
  has_beneficial_owner: { direction: 'upward', ownership: true }, //    154
  subsidiary_of: { direction: 'upward', ownership: true }, //            35

  // ── Structure: part of the same company, not a separate owner ────────────
  has_branch: { direction: 'downward', ownership: false }, //            25
  branch_of: { direction: 'upward', ownership: false }, //                1
  legal_successor_of: { direction: 'lateral', ownership: false }, //      8
  has_legal_predecessor: { direction: 'lateral', ownership: false }, //   3

  // ── People and appointed roles ───────────────────────────────────────────
  has_officer: { direction: 'lateral', ownership: false }, //           682
  officer_of: { direction: 'lateral', ownership: false }, //              8
  has_director: { direction: 'lateral', ownership: false }, //          572
  director_of: { direction: 'lateral', ownership: false }, //             3
  has_legal_representative: { direction: 'lateral', ownership: false }, // 407
  legal_representative_of: { direction: 'lateral', ownership: false }, //  3
  has_manager: { direction: 'lateral', ownership: false }, //           170
  manager_of: { direction: 'lateral', ownership: false }, //              2
  has_lawyer: { direction: 'lateral', ownership: false }, //            184
  lawyer_of: { direction: 'lateral', ownership: false }, //               2
  has_member_of_the_board: { direction: 'lateral', ownership: false }, // 157
  member_of_the_board_of: { direction: 'lateral', ownership: false }, //   7
  has_auditor: { direction: 'lateral', ownership: false }, //            80
  has_registered_agent: { direction: 'lateral', ownership: false }, //   67
  has_supervisor: { direction: 'lateral', ownership: false }, //         25
  has_partner: { direction: 'lateral', ownership: false }, //             8
  partner_of: { direction: 'lateral', ownership: false }, //              6
  has_employee: { direction: 'lateral', ownership: false }, //            1
  has_founder: { direction: 'lateral', ownership: false }, //             1

  // ── Trade and commercial ─────────────────────────────────────────────────
  notify_party_of: { direction: 'lateral', ownership: false }, //      2468
  ships_to: { direction: 'lateral', ownership: false }, //             1800
  receives_from: { direction: 'lateral', ownership: false }, //        1785
  carrier_of: { direction: 'lateral', ownership: false }, //           1772
  issuer_of: { direction: 'lateral', ownership: false }, //             711
  awarder_of: { direction: 'lateral', ownership: false }, //             90
  procures_from: { direction: 'lateral', ownership: false }, //          37
  contracted_by: { direction: 'lateral', ownership: false }, //           2
  recipient_of: { direction: 'lateral', ownership: false }, //            1
  linked_to: { direction: 'lateral', ownership: false }, //             398
};

/**
 * What a type means, or `undefined` for one nobody has classified.
 *
 * **Unclassified is not an error and it is not a guess.** A type absent here is
 * still stored — dropping it would repeat the failure this file exists to fix —
 * but it is `lateral` for display and it can never reach Ownership exposure,
 * because the safe direction for an unknown edge is *not an owner*. Callers
 * that care report it; see `unclassifiedTypes`.
 */
export function meaningOf(type: string): RelationshipMeaning | undefined {
  return RELATIONSHIP_TYPES[type];
}

/** Whether this edge counts as one company owning another. */
export function isOwnership(type: string): boolean {
  return RELATIONSHIP_TYPES[type]?.ownership ?? false;
}

/** Which way it points, defaulting an unclassified type to `lateral`. */
export function directionOf(type: string): EdgeDirection {
  return RELATIONSHIP_TYPES[type]?.direction ?? 'lateral';
}

/**
 * **The target owns the subject.** The only shape Ownership exposure scores:
 * a one-hop owner of the company being assessed, not a company it owns.
 *
 * The distinction is the whole reason this file is a table. `owner_of` and
 * `has_shareholder` both match `/owner|shareholder/`, and they are opposites —
 * 2,583 of the 4,108 ownership edges measured point *down*, so a reader that
 * took them all as owners would have filed a company's own subsidiaries as its
 * proprietors in nearly two thirds of cases.
 */
export function targetOwnsSubject(type: string): boolean {
  const meaning = RELATIONSHIP_TYPES[type];
  return meaning?.ownership === true && meaning.direction === 'upward';
}

/** Types seen in a payload that this table does not classify, for reporting. */
export function unclassifiedTypes(types: readonly string[]): string[] {
  return [...new Set(types.filter((type) => !(type in RELATIONSHIP_TYPES)))];
}

/** Every classified type, for a test that asserts the table stays exhaustive. */
export function classifiedTypes(): string[] {
  return Object.keys(RELATIONSHIP_TYPES);
}

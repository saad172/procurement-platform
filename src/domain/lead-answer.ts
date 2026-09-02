/**
 * How a Lead's relation to an existing Supplier is said, for the Category
 * page's `LeadsTable` and the `lead_table` chat widget alike.
 *
 * CONTEXT.md's **Lead** entry draws the line this function encodes: an
 * unverified relationship shown as fact is worse than one shown as a
 * question. Written twice, the two copies drifted — the page said "possibly
 * related · name match, unverified" and the widget said "possibly related ·
 * unverified", quietly dropping the one word that says *how* the relation
 * was guessed. One definition now; each renderer supplies its own markup.
 */
export type LeadRelation =
  | { kind: 'verified'; label: string; title: string }
  | { kind: 'unverified'; label: string }
  | { kind: 'none' };

/**
 * `relatedName` is the Supplier the relation is *to*, where the caller holds
 * it — SPEC §11.2 words both badges with the company in them, *related to
 * Yazaki (ownership, verified)* and *possibly related to Yazaki (name match,
 * unverified)*, and until the Discover Job started storing
 * `related_supplier_id` there was no id to look a name up by. The chat widget
 * has ids and no names (it selects bare `lead` rows), so the unnamed wording
 * stays exactly as it was rather than becoming a second definition.
 */
export function leadRelation(
  lead: {
    relationVerified: boolean;
    relatedSupplierId?: string | null | undefined;
  },
  relatedName?: string | null | undefined,
): LeadRelation {
  if (lead.relationVerified) {
    return {
      kind: 'verified',
      label: relatedName
        ? `related to ${relatedName} by ownership · verified`
        : 'related by ownership · verified',
      title: "Found in an accepted supplier's ownership family",
    };
  }
  if (lead.relatedSupplierId) {
    return {
      kind: 'unverified',
      label: relatedName
        ? `possibly related to ${relatedName} · name match, unverified`
        : 'possibly related · name match, unverified',
    };
  }
  return { kind: 'none' };
}

/**
 * How a Lead's classification is said, including when there is none.
 *
 * **`unclear` is a real answer and is often the right one** — a guess dressed
 * as a classification is worse than an admission, because a person reviewing
 * Leads can act on *unclear* and cannot act on a confident mistake. Which is
 * the whole reason a failed classifier may not be written as `unclear`: the
 * Job used to store `submitted?.classification ?? 'unclear'`, so a loop that
 * hit its cap and a model that had looked and could not tell rendered as the
 * same word.
 *
 * A row with neither a classification nor a reason is one Discover wrote
 * before the two were distinguished; it says *not classified* and claims
 * nothing about why.
 */
export type LeadClassificationLabel =
  | { kind: 'classified'; label: string; manufacturer: boolean }
  | { kind: 'not_classified'; label: string; title: string | null };

export function leadClassificationLabel(lead: {
  classification?: string | null | undefined;
  notClassifiedReason?: string | null | undefined;
}): LeadClassificationLabel {
  if (lead.classification) {
    return {
      kind: 'classified',
      label: lead.classification.replace(/_/g, ' '),
      manufacturer: lead.classification === 'manufacturer',
    };
  }
  return {
    kind: 'not_classified',
    label: lead.notClassifiedReason
      ? `not classified: ${lead.notClassifiedReason}`
      : 'not classified',
    title: lead.notClassifiedReason ?? null,
  };
}

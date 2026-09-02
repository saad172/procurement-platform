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

export function leadRelation(lead: {
  relationVerified: boolean;
  relatedSupplierId?: string | null | undefined;
}): LeadRelation {
  if (lead.relationVerified) {
    return {
      kind: 'verified',
      label: 'related by ownership · verified',
      title: "Found in an accepted supplier's ownership family",
    };
  }
  if (lead.relatedSupplierId) {
    return { kind: 'unverified', label: 'possibly related · name match, unverified' };
  }
  return { kind: 'none' };
}

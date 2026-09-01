import { eq } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as t from '@/db/schema';
import { settleDiscoveredLead } from '@/domain/match/settle-match';

/**
 * Promoting a Lead into a Supplier (SPEC §11.3).
 *
 * **A promoted Lead gets a pre-settled Match**: `accepted`,
 * `settled_by: 'discovered'`, **zero `match_attempt` rows**.
 *
 * That is what keeps `match` **total over Suppliers**, so the scoring bands,
 * the lifecycle and the Excluded block need **no fourth case**. A "discovered,
 * therefore unmatched" state would have propagated into every one of them.
 *
 * The UI renders *Identity: discovered*, **never *verified***, and a null
 * `matchStrength` reads as strong — because no name matching happened for it to
 * be weak at.
 */
export async function promoteLead(
  db: Database,
  args: { leadId: string; confirmedCategoryIds: string[] },
): Promise<{ supplierId: string }> {
  const lead = await db.query.lead.findFirst({ where: eq(t.lead.id, args.leadId) });
  if (!lead) throw new Error(`no lead ${args.leadId}`);

  const entity = await db.query.entity.findFirst({ where: eq(t.entity.id, lead.entityId) });

  const [supplier] = await db
    .insert(t.supplier)
    .values({
      programId: lead.programId,
      origin: 'discovered',
      // Roster columns stay NULL: a promoted Lead was never imported, and the
      // CHECK constraint on `supplier` refuses a half-populated row.
      rosterIndex: null,
      rosterName: null,
      rosterAddress: null,
      /**
       * Country comes from the **`attributes.address` country**, falling back
       * to `unknown` — **never** the first entry of the multi-valued
       * `countries[]`, which returned eight values for one measured company.
       *
       * The roster half of the country-disagreement finding is rendered as
       * *absent* rather than blank, which is why this stays null.
       */
      rosterCountry: null,
    })
    .returning({ id: t.supplier.id });

  // The seeding Category is pre-checked in the promote dialog and CONFIRMED BY
  // A PERSON, which keeps `supplier_category` hand-authored in the only sense
  // the seed cared about.
  const categoryIds =
    args.confirmedCategoryIds.length > 0 ? args.confirmedCategoryIds : [lead.categoryId];
  for (const categoryId of categoryIds) {
    await db
      .insert(t.supplierCategory)
      .values({ supplierId: supplier!.id, categoryId })
      .onConflictDoNothing();
  }

  await settleDiscoveredLead(db, { supplierId: supplier!.id, entityId: lead.entityId });

  await db
    .update(t.lead)
    .set({ promotedSupplierId: supplier!.id })
    .where(eq(t.lead.id, args.leadId));

  void entity;
  return { supplierId: supplier!.id };
}

/**
 * Dismissal is **per `(Program, Category)` and reversible** behind a *show
 * dismissed* toggle.
 *
 * It has to persist, or the same nine freight forwarders come back on every
 * run — which is the difference between a review surface and a treadmill.
 */
export async function dismissLead(db: Database, leadId: string, dismissed = true): Promise<void> {
  await db.update(t.lead).set({ dismissed }).where(eq(t.lead.id, leadId));
}

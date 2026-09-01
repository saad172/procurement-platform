import { desc, eq } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as t from '@/db/schema';

/**
 * A Supplier's Enrichments, with their **age already computed**.
 *
 * The age is computed here rather than in the component for two reasons, and
 * only one of them is the linter: reading a clock during render is not
 * idempotent, and a page that re-renders would show a different number for the
 * same row. Doing it in the query means one clock read per request.
 *
 * The age itself **reports and never acts** (SPEC §7.2): staleness forces the
 * caveat line rather than blocking anything, and there is no TTL and no
 * background refresh — a background TTL would spend credits on page views.
 */
export type EnrichmentRow = typeof t.enrichment.$inferSelect & {
  ageDays: number;
  /** Over 30 days: old enough that a sentence citing it owes a caveat. */
  needsCaveat: boolean;
};

export async function loadEnrichments(db: Database, subjectKey: string): Promise<EnrichmentRow[]> {
  const rows = await db
    .select()
    .from(t.enrichment)
    .where(eq(t.enrichment.subjectKey, subjectKey))
    .orderBy(desc(t.enrichment.fetchedAt));

  const now = Date.now();
  return rows.map((row) => {
    const ageDays = Math.floor((now - row.fetchedAt.getTime()) / 86_400_000);
    return { ...row, ageDays, needsCaveat: ageDays >= 30 };
  });
}

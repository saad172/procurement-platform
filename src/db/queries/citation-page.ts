import { eq } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as t from '@/db/schema';
import { loadSentenceEvidence } from '@/db/queries/citations';

/**
 * Everything this page renders, in one read (SPEC §13.1).
 *
 * A page reads through `db/queries`, never through the schema — see
 * `supplier-page.ts` for why.
 */
export async function loadCitationPage(
  db: Database,
  args: { programId: string; sentenceId: string },
) {
  const { programId, sentenceId } = args;

  const evidence = await loadSentenceEvidence(db, { programId, sentenceId });
  if (!evidence) return undefined;

  const program = await db.query.program.findFirst({ where: eq(t.program.id, programId) });
  const { sentence, owner, citations } = evidence;

  const trail =
    owner.kind === 'assessment'
      ? [
          { label: program?.name ?? 'Program', href: `/program/${programId}` },
          { label: owner.supplierName, href: `/program/${programId}/supplier/${owner.supplierId}` },
          { label: 'Evidence' },
        ]
      : [
          { label: program?.name ?? 'Program', href: `/program/${programId}` },
          { label: owner.categoryName, href: `/program/${programId}/category/${owner.categoryId}` },
          { label: 'Evidence' },
        ];

  return {
    trail,
    sentence,
    owner,
    citations,
  };
}

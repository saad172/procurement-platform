import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { getPooledDb } from '@/db/client';
import * as t from '@/db/schema';
import { Breadcrumb } from '@/components/breadcrumb';
import { ChatDock } from '@/components/chat-dock';
import { loadSentenceEvidence } from '@/db/queries/citations';

/**
 * Where the `❡` lands (SPEC §13.7) — **the bottom of the assessment's spine**.
 *
 * The link after every published sentence pointed here for as long as there
 * have been Assessments, and the route did not exist: **169 live links, every
 * one a 404**. The evidence was never the missing part — all 169 sentences
 * carry at least one Citation, 236 in total — so this page is the landing
 * place rather than a new feature.
 *
 * ## Why one route rather than one per owner
 *
 * A Citation belongs to a **sentence**, and a sentence knows what published it:
 * `sentence_one_owner` guarantees exactly one of an Assessment version or a
 * Recommendation version. So the trail back is derivable, and the route does
 * not need the Supplier or the Category in its path to build one. The
 * Recommendation's sentences get the same page for free, which they will need
 * the moment one is published.
 *
 * ## Why it lists rather than redirects
 *
 * 115 of the 169 sentences cite exactly one thing and 54 cite between two and
 * five, across two different target kinds. Redirecting through would have to
 * pick one of them and drop the rest silently — and *what else this sentence
 * rests on* is the question a reader following a citation is usually asking.
 */
export default async function CitationPage({
  params,
}: {
  params: Promise<{ programId: string; sentenceId: string }>;
}) {
  const { programId, sentenceId } = await params;
  const db = getPooledDb();

  const evidence = await loadSentenceEvidence(db, { programId, sentenceId });
  if (!evidence) notFound();

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

  return (
    <main>
      <Breadcrumb trail={trail} />
      <h1>What this sentence rests on</h1>
      <p className="sub">
        {owner.kind === 'assessment'
          ? `${owner.supplierName} · assessment version ${owner.versionN}`
          : `${owner.categoryName} · recommendation version ${owner.versionN}`}{' '}
        · {sentence.section.replace(/_/g, ' ')}
      </p>

      <div className="card">
        <p style={{ margin: 0 }}>{sentence.text}</p>
      </div>

      <h2>
        {citations.length === 1 ? 'One citation' : `${citations.length} citations`}
      </h2>
      <div className="card">
        {citations.length === 0 ? (
          /*
           * `submit-checks` refuses to publish a sentence with no citation, so
           * this is unreachable through the pipeline. It is rendered rather
           * than assumed away, because "every sentence carries a citation" is
           * a claim the build stakes itself on and a blank page would be a
           * worse way to learn it had stopped being true.
           */
          <p className="empty">
            This sentence carries no citation, which a published assessment cannot do.
          </p>
        ) : (
          <table>
            <caption className="note">
              Every source this sentence names, with what it says and where it lives.
            </caption>
            <thead>
              <tr>
                <th scope="col">Kind</th>
                <th scope="col">Source</th>
                <th scope="col">What it says</th>
              </tr>
            </thead>
            <tbody>
              {citations.map((citation) => (
                <tr key={citation.id}>
                  <td className="note">{citation.kind.replace(/_/g, ' ')}</td>
                  <td>
                    {citation.href ? (
                      <Link href={citation.href as never}>{citation.title}</Link>
                    ) : (
                      citation.title
                    )}
                    {citation.dangling ? (
                      <>
                        {' '}
                        <span className="badge warn">not stored</span>
                      </>
                    ) : null}
                  </td>
                  <td className="note">{citation.detail ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="note" style={{ marginTop: '1rem' }}>
        <Link
          href={
            (owner.kind === 'assessment'
              ? `/program/${programId}/supplier/${owner.supplierId}`
              : `/program/${programId}/category/${owner.categoryId}/recommendation`) as never
          }
        >
          ← back to the {owner.kind}
        </Link>
      </p>
      <ChatDock programId={programId} />
    </main>
  );
}

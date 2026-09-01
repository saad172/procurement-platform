import Link from 'next/link';
import type { loadCitationPage } from '@/db/queries/citation-page';

/**
 * The Citation page's one section (SPEC §13.7). A one-`<h2>` page still gets
 * a `sections.tsx` with one component, applied uniformly with every other
 * page — the split is a rule, not a per-page judgment call.
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
type Data = NonNullable<Awaited<ReturnType<typeof loadCitationPage>>>;

/** ── One citation / N citations ── */
export function Citations({ data }: { data: Data }) {
  const { citations } = data;
  return (
    <>
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
    </>
  );
}

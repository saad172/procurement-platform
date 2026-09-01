import Link from 'next/link';
import type { loadCitationPage } from '@/db/queries/citation-page';

/**
 * The Citation page's one section (SPEC §13.7). A one-`<h2>` page still gets
 * a `sections.tsx` with one component, applied uniformly with every other
 * page — the split is a rule, not a per-page judgment call.
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

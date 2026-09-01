import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getPooledDb } from '@/db/client';
import { loadCategoryPage } from '@/db/queries/category-page';
import { Breadcrumb } from '@/components/breadcrumb';
import { ChatDock } from '@/components/chat-dock';
import { WeightRail } from '@/components/weight-rail';
import { CategoryActions } from './category-actions';
import { LeadsTable } from './leads';

/**
 * The Category page (SPEC §13.3, §13.6) — level two of the spine.
 *
 * Its Shortlist is the Suppliers of this Program × Category ranked by Score,
 * and two rules govern what a reader sees:
 *
 * - **Excluded is never ranked low.** A Supplier with no settled Match carries
 *   no Score, shows **no estimated Criterion**, and appears in a separate
 *   *Excluded from the ranking* block beneath — with its two reasons rendered
 *   differently, because "we could not identify this company" and "it bids on
 *   nothing here" are different problems.
 * - **A filtered row keeps its true rank**, so visible rows read 2, 5, 7 with
 *   the gaps left in. **The gap is the disclosure.**
 */
export default async function CategoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ programId: string; categoryId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { programId, categoryId } = await params;
  const query = await searchParams;

  const data = await loadCategoryPage(getPooledDb(), { programId, categoryId, query });
  if (!data) notFound();

  const {
    program,
    category,
    programDefault,
    shortlist,
    scoredLine,
    leads,
    version,
    answers,
  } = data;
  return (
    <main>
      <Breadcrumb
        trail={[
          { label: program.name, href: `/program/${programId}` },
          { label: `${category.code} — ${category.name}` },
        ]}
      />
      <h1>{category.name}</h1>
      <p className="sub">
        {shortlist.totalCount} {shortlist.totalCount === 1 ? 'company' : 'companies'} bidding
        {shortlist.excluded.length > 0
          ? ` · ${shortlist.excluded.length} that cannot be ranked yet`
          : ''}
        {scoredLine ? ` · ${scoredLine.label}, ${Number(scoredLine.rate)}% duty into ${program.importingCountry}` : ''}
      </p>

      {/* ── The answers, before any of the apparatus ── */}
      {answers.map((answer) => (
        <div
          key={answer.said}
          className={`answer ${answer.tone === 'neutral' ? '' : answer.tone}`}
        >
          <p className="said">{answer.said}</p>
          <p className="because">{answer.because}</p>
          {answer.actions.some((action) => action.href) ? (
            <div className="do">
              {answer.actions
                .filter((action) => action.href)
                .map((action) => (
                  <Link
                    key={action.label}
                    className={`btn ${action.primary ? 'primary' : ''}`}
                    href={action.href as never}
                  >
                    {action.label}
                  </Link>
                ))}
            </div>
          ) : null}
          {/*
            An action that SPENDS stays with `CategoryActions`, which owns the
            POST, the ceiling and the disabled state. The answer names it; it
            does not grow a second copy of a button that costs money.
          */}
          {answer.actions.some((action) => action.action === 'recommend') ? (
            <div className="do">
              <CategoryActions
                programId={programId}
                categoryId={categoryId}
                shortlistSize={shortlist.ranked.length}
                inline
              />
            </div>
          ) : null}
        </div>
      ))}


      <h2>
        <span className="term">Who is bidding, best fit first<i>Shortlist</i></span>
        {shortlist.visibleCount !== shortlist.totalCount ? (
          <span className="note">
            {' '}
            showing {shortlist.visibleCount} of {shortlist.totalCount} —{' '}
            <Link href={`/program/${programId}/category/${categoryId}` as never}>clear the filter</Link>
          </span>
        ) : null}
      </h2>

      <div className="card scroll-x">
        <table>
          <thead>
            <tr>
              <th className="num">Rank</th>
              <th>Supplier</th>
              <th className="num">Score</th>
              <th>Coverage</th>
              <th>Data confidence</th>
              <th>Flags</th>
            </tr>
          </thead>
          <tbody>
            {shortlist.ranked.length === 0 ? (
              <tr><td colSpan={6} className="empty">Nothing is ranked here yet.</td></tr>
            ) : (
              shortlist.ranked.map((row) => (
                <tr key={row.supplierId} className={row.visible ? undefined : 'hidden-by-filter'}>
                  {/* The rank is the TRUE one, computed over the unfiltered set. */}
                  <td className="num">{row.rank}</td>
                  <td>
                    <Link href={`/program/${programId}/supplier/${row.supplierId}` as never}>
                      {row.displayName}
                    </Link>
                  </td>
                  <td className="num">
                    <strong>{row.score?.toFixed(1)}</strong>
                  </td>
                  <td className="note">
                    {row.coverage.computed} of {row.coverage.total} criteria
                  </td>
                  <td>
                    <span className={`badge ${row.dataConfidence === 'strong' ? 'good' : row.dataConfidence === 'thin' ? 'warn' : 'mute'}`}>
                      {row.dataConfidence}
                    </span>
                  </td>
                  <td>
                    {row.disqualifying ? (
                      <span className="badge bad" title={row.disqualifyingFactors.join(', ')}>
                        disqualifying
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {shortlist.excluded.length > 0 ? (
        <>
          <h2>In this program, but not rankable yet</h2>
          <div className="card">
            {/*
              Two DISTINCT reasons, rendered differently. A Supplier we could not
              identify and one that bids on nothing here are different problems,
              and clicking the first opens the resolver's candidates rather than
              a score breakdown it does not have.
            */}
            {(['no_match', 'no_category'] as const).map((reason) => {
              const rows = shortlist.excluded.filter((e) => e.reason === reason);
              if (rows.length === 0) return null;
              return (
                <div key={reason} style={{ marginBottom: '1rem' }}>
                  <h3 style={{ marginTop: 0 }}>
                    {reason === 'no_match'
                      ? 'No settled match — we could not say which company this is'
                      : 'Not mapped to any category in this program'}
                  </h3>
                  <p className="note">
                    {reason === 'no_match'
                      ? 'These carry no score and show no estimated criterion. Opening one shows the resolver’s candidates and rounds, not a breakdown.'
                      : 'These walk the whole lifecycle and simply reach no shortlist. It is the honest shape of a real roster.'}
                  </p>
                  <ul style={{ margin: '0.4rem 0 0', paddingLeft: '1.1rem' }}>
                    {rows.map(({ row }) => (
                      <li key={row.supplierId}>
                        <Link href={`/program/${programId}/supplier/${row.supplierId}` as never}>
                          {row.displayName}
                        </Link>{' '}
                        <span className="badge mute">{row.matchStatus ?? 'not yet run'}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </>
      ) : null}

      <LeadsTable
        programId={programId}
        categoryId={categoryId}
        categoryCode={category.code}
        leads={leads}
        showDismissed={query.dismissed === '1'}
      />

      {/*
        A pointer, not news. Whether a recommendation exists is the second
        answer at the top of the page; repeating it here would be the page
        saying the same thing twice at two different weights, which is how the
        verdict came to be invisible in the first place.
      */}
      {version ? (
        <>
          <h2>
            <span className="term">The argued case<i>Recommendation</i></span>
          </h2>
          <div className="card">
            <p style={{ margin: 0 }}>
              <Link href={`/program/${programId}/category/${categoryId}/recommendation` as never}>
                Version {version.n}
              </Link>{' '}
              <span className={`badge ${version.evaluatorOutcome === 'passed' ? 'good' : 'warn'}`}>
                {version.evaluatorOutcome.replace(/_/g, ' ')}
              </span>{' '}
              {version.humanMark ? (
                <span className="badge">marked {version.humanMark.replace(/_/g, ' ')} by a person</span>
              ) : null}
            </p>
          </div>
        </>
      ) : null}

      {/* ── The working: the apparatus the ranking was produced with ── */}
      <h2>The working</h2>
      <p className="note" style={{ margin: '-0.4rem 0 0.8rem', maxWidth: '56rem' }}>
        The duty the tariff criterion scores, and the weights the ranking above was computed
        with. Move a weight and the order re-reads live.
      </p>
      {/*
        The full Actions card, which still owns Discover — only the Recommend
        button moved up into the answer that names it. Both write to the same
        server action; neither is a second copy of the other.
      */}
      <CategoryActions
        programId={programId}
        categoryId={categoryId}
        shortlistSize={shortlist.ranked.length}
      />

      <div className="grid two" style={{ marginTop: '1rem' }}>
        <section className="card">
          <h3 style={{ marginTop: 0 }}>
            <span className="term">What it costs to bring in<i>Tariff</i></span>
          </h3>
          <table>
            <tbody>
              {category.hsLines.map((line) => (
                <tr key={line.id}>
                  <td className="mono">{line.hsCode}</td>
                  <td>{line.label}</td>
                  <td className="num">{Number(line.rate)}%</td>
                  <td>{line.isDefault ? <span className="badge">scored</span> : <span className="badge mute">candidate</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {/*
            The mandatory caveat, rendered with every rate. Trade-action flags
            are AUTHORED and never computed — they key on facts this app does
            not have — so they ride beside the number rather than inside it.
          */}
          <p className="note" style={{ marginTop: '0.6rem' }}>
            {scoredLine ? `${Number(scoredLine.rate)}% is the general (MFN) rate for ${scoredLine.hsCode} into ${program.importingCountry}. ` : ''}
            Trade-action surcharges are not folded into it: they key on melt-and-pour origin, regional
            value content and declared end-use, which are facts this application does not hold.
          </p>
          {category.flags.length > 0 ? (
            <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
              {category.flags.map((f) => (
                <span key={f.flagKey} className="badge warn" title={f.flag.whyNotARate}>
                  {f.flag.label}
                </span>
              ))}
            </div>
          ) : null}
        </section>

        <WeightRail programDefault={programDefault} live />
      </div>
      <ChatDock programId={programId} />
    </main>
  );
}

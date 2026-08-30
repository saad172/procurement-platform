import Link from 'next/link';
import { notFound } from 'next/navigation';
import { desc, eq } from 'drizzle-orm';
import { getPooledDb } from '@/db/client';
import * as t from '@/db/schema';
import { Breadcrumb } from '@/components/breadcrumb';
import { ChatDock } from '@/components/chat-dock';
import { WeightRail } from '@/components/weight-rail';
import { loadShortlist } from '@/db/queries/shortlist';
import { parseViewState } from '@/lib/view-state';
import { DEFAULT_WEIGHTS } from '@/domain/score';
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
  const db = getPooledDb();

  const program = await db.query.program.findFirst({
    where: eq(t.program.id, programId),
    with: { weights: true },
  });
  const category = await db.query.category.findFirst({
    where: eq(t.category.id, categoryId),
    with: { hsLines: true, flags: { with: { flag: true } } },
  });
  if (!program || !category) notFound();

  const programDefault = {
    ...DEFAULT_WEIGHTS,
    ...Object.fromEntries(program.weights.map((w) => [w.criterionKey, Number(w.weight)])),
  };
  const view = parseViewState(query, programDefault);

  const shortlist = await loadShortlist(db, {
    programId,
    categoryId,
    weights: view.weights,
    facets: view.facets,
  });

  const recommendation = await db.query.recommendation.findFirst({
    where: eq(t.recommendation.categoryId, categoryId),
    with: { versions: { orderBy: [desc(t.recommendationVersion.n)], limit: 1 } },
  });

  const scoredLine = category.hsLines.find((l) => l.isDefault);

  const leads = await db
    .select({ lead: t.lead, entity: t.entity })
    .from(t.lead)
    .innerJoin(t.entity, eq(t.entity.id, t.lead.entityId))
    .where(eq(t.lead.categoryId, categoryId));

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
        {shortlist.totalCount} bidder{shortlist.totalCount === 1 ? '' : 's'} ·{' '}
        {shortlist.excluded.length} excluded from the ranking
      </p>

      <div className="grid two">
        <section className="card">
          <h3 style={{ marginTop: 0 }}>Tariff</h3>
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

      <h2>
        Shortlist
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
          <h2>Excluded from the ranking</h2>
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
                      : 'Bids on no category in this programme'}
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

      <h2>Recommendation</h2>
      <div className="card">
        {recommendation?.versions[0] ? (
          <p>
            <Link href={`/program/${programId}/category/${categoryId}/recommendation` as never}>
              Version {recommendation.versions[0].n}
            </Link>{' '}
            <span className={`badge ${recommendation.versions[0].evaluatorOutcome === 'passed' ? 'good' : 'warn'}`}>
              {recommendation.versions[0].evaluatorOutcome.replace(/_/g, ' ')}
            </span>
          </p>
        ) : (
          <p className="note" style={{ margin: 0 }}>
            No recommendation has been written for this category yet. A recommendation always runs
            against the <strong>unfiltered</strong> shortlist — a filtered set would exclude suppliers
            with no sentence saying why.
          </p>
        )}
      </div>
      <ChatDock programId={programId} />
    </main>
  );
}

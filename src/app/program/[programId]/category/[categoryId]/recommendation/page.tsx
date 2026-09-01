import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getPooledDb } from '@/db/client';
import { loadRecommendationPage } from '@/db/queries/recommendation-page';
import { Breadcrumb } from '@/components/breadcrumb';
import { ChatDock } from '@/components/chat-dock';
import { Argument, Dissent, Picks } from './sections';

/**
 * The published Recommendation for one Category (SPEC §10).
 *
 * The Category page has linked here since Recommendations existed, guarded on
 * one having been published — and none ever had, so the link had never been
 * followed and the route had never been written. It would have 404'd on the
 * first Recommendation anybody produced, which is the worst moment to find out.
 *
 * ## `human_mark` is recorded and never acted on
 *
 * A person accepting or rejecting a Recommendation changes nothing downstream:
 * it is a note about what a human decided, not an input. Rendering it as a
 * badge beside the version, rather than as the page's verdict, is what keeps
 * that distinction visible.
 */
export default async function RecommendationPage({
  params,
}: {
  params: Promise<{ programId: string; categoryId: string }>;
}) {
  const { programId, categoryId } = await params;

  const data = await loadRecommendationPage(getPooledDb(), { programId, categoryId });
  if (!data) notFound();

  const { category, program, version } = data;

  return (
    <main>
      <Breadcrumb
        trail={[
          { label: program?.name ?? 'Program', href: `/program/${programId}` },
          { label: category.name, href: `/program/${programId}/category/${categoryId}` },
          { label: 'Recommendation' },
        ]}
      />
      <h1>{category.name}</h1>
      <p className="sub">{category.code} · what to do about this category</p>

      {!version ? (
        <div className="card">
          <p className="empty" style={{ margin: 0 }}>
            No recommendation has been written for this category yet. A recommendation always runs
            against the <strong>unfiltered</strong> shortlist — a filtered set would exclude
            suppliers with no sentence saying why.
          </p>
        </div>
      ) : (
        <>
          <p>
            Version {version.n}{' '}
            <span className={`badge ${version.evaluatorOutcome === 'passed' ? 'good' : 'warn'}`}>
              {version.evaluatorOutcome.replace(/_/g, ' ')}
            </span>{' '}
            {version.humanMark ? (
              <span className="badge">
                marked {version.humanMark.replace(/_/g, ' ')} by a person
              </span>
            ) : null}
          </p>

          <Picks data={data} programId={programId} />
          <Argument data={data} programId={programId} />
          <Dissent data={data} />
        </>
      )}

      <p className="note" style={{ marginTop: '1rem' }}>
        <Link href={`/program/${programId}/category/${categoryId}` as never}>
          ← back to the category
        </Link>
      </p>
      <ChatDock programId={programId} />
    </main>
  );
}

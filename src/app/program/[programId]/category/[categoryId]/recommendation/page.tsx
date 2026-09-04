import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getPooledDb } from '@/db/client';
import { loadRecommendationPage } from '@/db/queries/recommendation-page';
import { Breadcrumb } from '@/components/breadcrumb';
import { ChatDock } from '@/components/chat-dock';
import { markHeader, newerVersionStrip, pinnedVersionStrip } from '@/domain/recommendation-mark';
import { Argument, ConcentrationPaths, Dissent, MarkControls, Picks, Versions } from './sections';

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
 *
 * The one thing it does move is **which version this page shows** (SPEC §12.5),
 * and that is not the mark acting on the argument — it is the page declining to
 * replace a decision somebody made with one nobody has read.
 */
export default async function RecommendationPage({
  params,
  searchParams,
}: {
  params: Promise<{ programId: string; categoryId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { programId, categoryId } = await params;
  const query = await searchParams;

  // `?version=` is how the strip below reaches a version the rule does not
  // show. A number that names no version falls back to the rule rather than
  // 404ing: it is a URL a person edited, not a missing page.
  const asked = Number(query.version);
  const versionN = Number.isInteger(asked) ? asked : undefined;

  const data = await loadRecommendationPage(getPooledDb(), { programId, categoryId, versionN });
  if (!data) notFound();

  const { category, program, version, latest, newer, pinned } = data;
  const markError = typeof query.markError === 'string' ? query.markError : undefined;
  const header = version
    ? markHeader({ mark: version.humanMark, markedAt: version.humanMarkedAt, versionN: version.n })
    : undefined;

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

      {!version || !header ? (
        <div className="card">
          <p className="empty" style={{ margin: 0 }}>
            No recommendation has been written for this category yet. A recommendation always runs
            against the <strong>unfiltered</strong> shortlist — a filtered set would exclude
            suppliers with no sentence saying why.
          </p>
        </div>
      ) : (
        <>
          {/*
            A refusal comes back as a sentence, never as a 500 on a page with
            four forms on it. Only a hand-made POST can reach one — the buttons
            carry ids this page just read — but an action open to the network is
            an action that will be sent nonsense.
          */}
          {markError ? (
            <div className="answer stop">
              <p className="said">{markError}</p>
              <p className="because">
                The version is exactly as it was. Nothing about a recommendation changes without a
                run, and a mark changes nothing but itself.
              </p>
            </div>
          ) : null}

          <p>
            Version {version.n}{' '}
            <span className={`badge ${version.evaluatorOutcome === 'passed' ? 'good' : 'warn'}`}>
              {version.evaluatorOutcome.replace(/_/g, ' ')}
            </span>{' '}
            <span className={`badge ${header.tone}`}>{header.badge}</span>
          </p>
          <p className="note" style={{ margin: '-0.4rem 0 1rem', maxWidth: '56rem' }}>
            {header.line}
          </p>

          <VersionStripBlock
            data={data}
            programId={programId}
            categoryId={categoryId}
            pinned={pinned}
            newer={newer}
            shownN={version.n}
            latestN={latest?.n ?? version.n}
          />

          <Picks data={data} programId={programId} />
          <Argument data={data} programId={programId} />
          <ConcentrationPaths data={data} programId={programId} />
          <Dissent data={data} />
          <Versions data={data} programId={programId} categoryId={categoryId} />
          <MarkControls data={data} programId={programId} categoryId={categoryId} />
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

/**
 * Which version is on screen, and why that one — above the argument, because it
 * changes what the argument below is.
 *
 * The two states are mutually exclusive by construction: either the reader
 * asked for a version by number, or the rule chose one and a newer sibling may
 * exist behind it.
 */
function VersionStripBlock({
  data,
  programId,
  categoryId,
  pinned,
  newer,
  shownN,
  latestN,
}: {
  data: NonNullable<Awaited<ReturnType<typeof loadRecommendationPage>>>;
  programId: string;
  categoryId: string;
  pinned: boolean;
  newer: number;
  shownN: number;
  latestN: number;
}) {
  const here = `/program/${programId}/category/${categoryId}/recommendation`;

  if (pinned) {
    const byDefault = data.versions.find((v) => v.humanMark === 'accepted') ?? data.versions[0];
    if (!byDefault) return null;
    const strip = pinnedVersionStrip({
      viewingN: shownN,
      defaultN: byDefault.n,
      defaultMark: byDefault.humanMark,
    });
    return (
      <div className="answer you">
        <p className="said">{strip.said}</p>
        <p className="because">{strip.because}</p>
        <div className="do">
          <Link className="btn" href={here as never}>
            Back to version {byDefault.n}
          </Link>
        </div>
      </div>
    );
  }

  if (newer === 0) return null;
  const strip = newerVersionStrip({ shownN, latestN, newer });
  return (
    <div className="answer you">
      <p className="said">{strip.said}</p>
      <p className="because">{strip.because}</p>
      <div className="do">
        <Link className="btn primary" href={`${here}?version=${latestN}` as never}>
          Read version {latestN}
        </Link>
      </div>
    </div>
  );
}

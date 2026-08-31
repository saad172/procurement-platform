import Link from 'next/link';
import { notFound } from 'next/navigation';
import { and, asc, desc, eq } from 'drizzle-orm';
import { getPooledDb } from '@/db/client';
import * as t from '@/db/schema';
import { Breadcrumb } from '@/components/breadcrumb';
import { ChatDock } from '@/components/chat-dock';

/**
 * The published Recommendation for one Category (SPEC §10).
 *
 * The Category page has linked here since Recommendations existed, guarded on
 * one having been published — and none ever had, so the link had never been
 * followed and the route had never been written. It would have 404'd on the
 * first Recommendation anybody produced, which is the worst moment to find out.
 *
 * ## What it shows, and in what order
 *
 * The **picks first**, because a Recommendation exists to say who to award to
 * and who to keep as a second source. The prose that argues for them comes
 * under it, headline first.
 *
 * Every sentence carries the same `❡` hop as an Assessment's, into the same
 * evidence page — a Recommendation's sentences are `sentence` rows with
 * Citations exactly like an Assessment's, so they get that for free.
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
  const db = getPooledDb();

  const category = await db.query.category.findFirst({
    where: and(eq(t.category.id, categoryId), eq(t.category.programId, programId)),
  });
  if (!category) notFound();

  const program = await db.query.program.findFirst({ where: eq(t.program.id, programId) });

  const recommendation = await db.query.recommendation.findFirst({
    where: and(eq(t.recommendation.categoryId, categoryId), eq(t.recommendation.programId, programId)),
    with: { versions: { orderBy: [desc(t.recommendationVersion.n)], limit: 1 } },
  });
  const version = recommendation?.versions[0];

  const picks = version
    ? await db
        .select({
          role: t.recommendationPick.role,
          rank: t.recommendationPick.rank,
          supplierId: t.supplier.id,
          rosterName: t.supplier.rosterName,
          entityLabel: t.entity.label,
        })
        .from(t.recommendationPick)
        .innerJoin(t.supplier, eq(t.supplier.id, t.recommendationPick.supplierId))
        .leftJoin(t.match, eq(t.match.supplierId, t.supplier.id))
        .leftJoin(t.entity, eq(t.entity.id, t.match.entityId))
        .where(eq(t.recommendationPick.recommendationVersionId, version.id))
        .orderBy(asc(t.recommendationPick.rank))
    : [];

  const sentences = version
    ? await db
        .select()
        .from(t.sentence)
        .where(eq(t.sentence.recommendationVersionId, version.id))
        .orderBy(t.sentence.section, t.sentence.ordinal)
    : [];

  const dissent = version
    ? await db.select().from(t.round).where(eq(t.round.recommendationVersionId, version.id))
    : [];

  return (
    <main>
      <Breadcrumb
        trail={[
          { label: program?.name ?? 'Programme', href: `/program/${programId}` },
          { label: category.name, href: `/program/${programId}/category/${categoryId}` },
          { label: 'Recommendation' },
        ]}
      />
      <h1>{category.name}</h1>
      <p className="sub">
        {category.code} · what to do about this category
      </p>

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
              <span className="badge">marked {version.humanMark.replace(/_/g, ' ')} by a person</span>
            ) : null}
          </p>

          <h2>Picks</h2>
          <div className="card">
            {picks.length === 0 ? (
              <p className="empty" style={{ margin: 0 }}>
                This recommendation names no supplier.
              </p>
            ) : (
              <table>
                <caption className="note">
                  Ranked as the recommendation ranked them, against the unfiltered shortlist.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Rank</th>
                    <th scope="col">Role</th>
                    <th scope="col">Supplier</th>
                  </tr>
                </thead>
                <tbody>
                  {picks.map((pick) => (
                    <tr key={pick.supplierId}>
                      <td>{pick.rank}</td>
                      <td>
                        <span className="badge">{pick.role.replace(/_/g, ' ')}</span>
                      </td>
                      <td>
                        <Link href={`/program/${programId}/supplier/${pick.supplierId}` as never}>
                          {pick.rosterName ?? pick.entityLabel ?? 'Supplier'}
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <h2>The argument</h2>
          <div className="card">
            {sentences.length === 0 ? (
              <p className="empty" style={{ margin: 0 }}>This version published no prose.</p>
            ) : (
              groupBySection(sentences).map(([section, rows]) => (
                <section key={section} style={{ marginTop: '1rem' }}>
                  <h3 style={{ marginTop: 0 }}>{section.replace(/_/g, ' ')}</h3>
                  {rows.map((sentence) => (
                    <p key={sentence.id} style={{ margin: '0 0 0.5rem' }}>
                      {sentence.text}{' '}
                      {/* The same hop as an Assessment's, into the same page. */}
                      <Link
                        href={`/program/${programId}/citation/${sentence.id}` as never}
                        title="Go to the evidence"
                        style={{ textDecoration: 'none' }}
                      >
                        ❡
                      </Link>
                    </p>
                  ))}
                </section>
              ))
            )}
          </div>

          {dissent.some((round) => round.objection) ? (
            <>
              <h2>Dissent</h2>
              <div className="card">
                <p className="note">
                  Nobody writes this section. It is what the disagreement left behind — the
                  objections this version published without resolving.
                </p>
                {dissent
                  .filter((round) => round.objection)
                  .map((round) => (
                    <p key={round.id} style={{ margin: '0 0 0.5rem' }}>
                      {round.objection}
                    </p>
                  ))}
              </div>
            </>
          ) : null}
        </>
      )}

      <p className="note" style={{ marginTop: '1rem' }}>
        <Link href={`/program/${programId}/category/${categoryId}` as never}>← back to the category</Link>
      </p>
      <ChatDock programId={programId} />
    </main>
  );
}

function groupBySection(sentences: (typeof t.sentence.$inferSelect)[]) {
  const map = new Map<string, (typeof t.sentence.$inferSelect)[]>();
  for (const sentence of sentences) {
    map.set(sentence.section, [...(map.get(sentence.section) ?? []), sentence]);
  }
  return [...map.entries()];
}

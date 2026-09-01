import Link from 'next/link';
import type * as t from '@/db/schema';
import type { loadRecommendationPage } from '@/db/queries/recommendation-page';

/**
 * The Recommendation page's sections (SPEC §10) — one component per `<h2>`.
 *
 * The **picks first**, because a Recommendation exists to say who to award to
 * and who to keep as a second source. The prose that argues for them comes
 * under it, headline first.
 */
type Data = NonNullable<Awaited<ReturnType<typeof loadRecommendationPage>>>;

/** ── Picks ── */
export function Picks({ data, programId }: { data: Data; programId: string }) {
  const { picks } = data;
  return (
    <>
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
    </>
  );
}

/**
 * ── The argument ──
 *
 * Every sentence carries the same `❡` hop as an Assessment's, into the same
 * evidence page — a Recommendation's sentences are `sentence` rows with
 * Citations exactly like an Assessment's, so they get that for free.
 */
export function Argument({ data, programId }: { data: Data; programId: string }) {
  const { sentences } = data;
  return (
    <>
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
    </>
  );
}

/**
 * ── Dissent ──
 *
 * Nobody writes this section. It is what the disagreement left behind — the
 * objections this version published without resolving.
 */
export function Dissent({ data }: { data: Data }) {
  const { dissent } = data;
  if (!dissent.some((round) => round.objection)) return null;
  return (
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
  );
}

function groupBySection(sentences: (typeof t.sentence.$inferSelect)[]) {
  const map = new Map<string, (typeof t.sentence.$inferSelect)[]>();
  for (const sentence of sentences) {
    map.set(sentence.section, [...(map.get(sentence.section) ?? []), sentence]);
  }
  return [...map.entries()];
}

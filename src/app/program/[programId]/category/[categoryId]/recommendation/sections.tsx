import Link from 'next/link';
import type * as t from '@/db/schema';
import { NetworkMapWithExpand } from '@/components/widgets/expand-node-button';
import type { loadRecommendationPage } from '@/db/queries/recommendation-page';
import {
  ACCEPT_CONTROL_NOTE,
  MARK_BUTTON_LABEL,
  MARK_CONTROL_NOTE,
  RECOMMENDATION_MARKS,
  markTone,
  markWord,
} from '@/domain/recommendation-mark';
import { clearRecommendationMark, markRecommendationVersion } from './mark-actions';

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
          <p className="empty" style={{ margin: 0 }}>
            This version published no prose.
          </p>
        ) : (
          groupBySection(sentences).map(([section, rows]) => (
            <section key={section} style={{ marginTop: '1rem' }}>
              <h3 style={{ marginTop: 0 }}>{section.replace(/_/g, ' ')}</h3>
              {rows.map((sentence) => (
                <p key={sentence.id} style={{ margin: '0 0 0.5rem' }}>
                  {sentence.text} {/* The same hop as an Assessment's, into the same page. */}
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
 * ── Concentration Paths ──
 *
 * Network spec §8's own Recommendation row: *"the Picks' Paths beside the
 * conditions that name them"*. Placed directly after Argument (which is
 * where the `conditions`/`open_questions` sentences render, grouped by
 * section — see `groupBySection` below) and before Dissent — juxtaposition
 * is what "beside" asks for here, not a cross-referencing UI: a condition
 * naming a second source's Concentration sits one section above the actual
 * Path backing it, rather than the two living on separate pages.
 *
 * `data.concentrationPaths` (`loadConcentrationPaths`,
 * `src/db/queries/recommendation-page.ts`) is already matched Pick-to-Path —
 * one row per `second_source` Pick a `shortest_path` Path was found for, the
 * SAME Path the ninth check's own objection names by `entityId` when it
 * fires (`checkConcentration`, `src/domain/validation/submit-checks.ts`).
 * Nothing renders when the array is empty — the common case, since most
 * Recommendations name no Concentration at all — the same "return null"
 * convention `Dissent` below already follows for its own empty case.
 */
export function ConcentrationPaths({ data, programId }: { data: Data; programId: string }) {
  const { concentrationPaths } = data;
  if (concentrationPaths.length === 0) return null;
  return (
    <>
      <h2>Concentration Paths</h2>
      {concentrationPaths.map(({ award, pick, path }) => (
        <div className="card" key={pick.supplierId} style={{ marginTop: '0.6rem' }}>
          <p className="note" style={{ marginTop: 0 }}>
            The award and{' '}
            <Link href={`/program/${programId}/supplier/${pick.supplierId}` as never}>
              {pick.rosterName ?? pick.entityLabel ?? 'this second source'}
            </Link>{' '}
            share a Path — the Concentration a condition or open question above should name.
          </p>
          <NetworkMapWithExpand
            roots={[{ id: award.entityId, label: award.label ?? award.entityId }]}
            paths={[{ ...path, kind: 'shortest_path', rootEntityId: award.entityId }]}
            programId={programId}
          />
        </div>
      ))}
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
          Nobody writes this section. It is what the disagreement left behind — the objections this
          version published without resolving.
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

/**
 * ── Your mark ──
 *
 * Four plain forms, no client state: the three marks CONTEXT names and a clear.
 * Each is a POST to a server action, so the control works before any JavaScript
 * has loaded — the same register as the Run panel and the Supplier actions.
 *
 * **It sits under the argument, not above it**, because a mark is what a reader
 * does *after* reading. The page still leads with the conclusion: what a person
 * already decided is in the header, where a reader who came to find out arrives
 * at it first; this is the control, and the working comes before the control.
 *
 * The reason is beside the buttons rather than behind a tooltip, and the button
 * that has a consequence somewhere else says what it is.
 */
export function MarkControls({
  data,
  programId,
  categoryId,
}: {
  data: Data;
  programId: string;
  categoryId: string;
}) {
  const { version } = data;
  if (!version) return null;
  const request = { programId, categoryId, versionId: version.id };

  return (
    <>
      <h2>Your mark</h2>
      <div className="card">
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {RECOMMENDATION_MARKS.map((mark) => (
            <form key={mark} action={markRecommendationVersion.bind(null, { ...request, mark })}>
              <button
                type="submit"
                className={`badge ${version.humanMark === mark ? markTone(mark) : ''}`}
                style={{ cursor: 'pointer', padding: '0.45rem 0.8rem' }}
                disabled={version.humanMark === mark}
              >
                {MARK_BUTTON_LABEL[mark]}
              </button>
            </form>
          ))}

          <form action={clearRecommendationMark.bind(null, request)}>
            <button
              type="submit"
              className="badge mute"
              style={{ cursor: 'pointer', padding: '0.45rem 0.8rem' }}
              disabled={version.humanMark == null}
            >
              Clear
            </button>
          </form>
        </div>

        <p className="note" style={{ marginTop: '0.6rem' }}>
          {MARK_CONTROL_NOTE}
        </p>
        <p className="note" style={{ margin: '0.3rem 0 0' }}>
          {ACCEPT_CONTROL_NOTE}
        </p>
      </div>
    </>
  );
}

/**
 * ── Every version, and what a person said about each ──
 *
 * A list of versions is a list of decisions, so each row carries its own mark
 * rather than only the one being shown. It is also the only way to reach a
 * version the rule does not show: *acceptance never moves* (SPEC §12.5), and a
 * newer sibling that could not be read would make that a trap rather than a
 * guarantee.
 */
export function Versions({
  data,
  programId,
  categoryId,
}: {
  data: Data;
  programId: string;
  categoryId: string;
}) {
  const { versions, version } = data;
  if (versions.length < 2) return null;
  const here = `/program/${programId}/category/${categoryId}/recommendation`;

  return (
    <>
      <h2>Versions</h2>
      <div className="card">
        <table>
          <caption className="note">
            A re-run always writes a version, even when the text is identical — “the weights changed
            and the argument didn’t” is the most interesting thing a diff can say.
          </caption>
          <thead>
            <tr>
              <th scope="col">Version</th>
              <th scope="col">Written</th>
              <th scope="col">Reviewer</th>
              <th scope="col">Mark</th>
            </tr>
          </thead>
          <tbody>
            {versions.map((row) => (
              <tr key={row.id}>
                <td>
                  {row.id === version?.id ? (
                    <strong>Version {row.n}</strong>
                  ) : (
                    <Link href={`${here}?version=${row.n}` as never}>Version {row.n}</Link>
                  )}
                </td>
                <td className="mono">{row.createdAt.toISOString().slice(0, 10)}</td>
                <td>
                  <span className={`badge ${row.evaluatorOutcome === 'passed' ? 'good' : 'warn'}`}>
                    {row.evaluatorOutcome.replace(/_/g, ' ')}
                  </span>
                </td>
                <td>
                  {row.humanMark ? (
                    <span className={`badge ${markTone(row.humanMark)}`}>
                      {markWord(row.humanMark)}
                    </span>
                  ) : (
                    <span className="badge mute">unmarked</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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

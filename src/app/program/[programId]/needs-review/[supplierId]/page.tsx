import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getPooledDb } from '@/db/client';
import { loadSettlePage } from '@/db/queries/settle-page';
import { Breadcrumb } from '@/components/breadcrumb';
import { IDENTITY_STANDARD, IDENTITY_TRAPS } from '@/config/constants';
import { type Choice, type ChoiceVerdict } from '@/domain/settle-choices';
import { settleByHand } from '../actions';

/**
 * Settling one parked roster row (SPEC §6.8).
 *
 * **The choice is the control.** What stood here asked a person to type a
 * 22-character opaque entity id into a free-text box — an id obtainable only by
 * opening a candidate's page and copying it out of the address bar — under a
 * table that repeated the same eight verdicts once per candidate. For NSK that
 * was seventy-two chips, sixty-eight of which said the same thing, and a
 * mistyped id came back as an unhandled 500 with no message.
 *
 * The three things that changed are all one idea: **say what differs, once.**
 * Verdicts every record shares are stated above the list. Records the checks
 * cannot separate are grouped, and the group says that is what it is. Every
 * remaining record is a radio, so the id never has to be seen, let alone typed.
 *
 * **Cached-first.** Everything here is already stored; nothing on this page
 * spends a Sayari credit, because a review page that charged for being opened
 * would be charging for curiosity.
 */
export default async function SettleRowPage({
  params,
  searchParams,
}: {
  params: Promise<{ programId: string; supplierId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { programId, supplierId } = await params;
  const query = await searchParams;

  const data = await loadSettlePage(getPooledDb(), { programId, supplierId, query });
  if (!data) notFound();

  const {
    answer,
    error,
    settled,
    done,
    supplier,
    match,
    attempts,
    programName,
    shared,
    groups,
  } = data;
  return (
    <main>
      {/*
        A real trail, not a parent pointer. The rest of the app renders
        `[program, current]` everywhere; the citation page builds the owner's
        trail from the record itself and this does the same, so the reader can
        get back to the list of what is still waiting without the back button.
      */}
      <Breadcrumb
        trail={[
          { label: programName, href: `/program/${programId}` },
          { label: 'Needs review', href: `/program/${programId}/needs-review` },
          { label: supplier.rosterName ?? 'This row' },
        ]}
      />
      <h1>{supplier.rosterName}</h1>
      <p className="sub">
        Roster row {supplier.rosterIndex} · {supplier.rosterAddress} · {supplier.rosterCountry}{' '}
        <span className={`badge ${match.status === 'needs_review' ? 'warn' : 'bad'}`}>
          {match.status.replace(/_/g, ' ')}
        </span>
      </p>

      {/*
        A refusal is a reason not to proceed, which is what `.answer.stop`
        already is — so it is one, rather than a fifth component wearing the
        same left rule. The headline is constant because the outcome always is:
        every refusal writes nothing, and only the reason varies.
      */}
      {error ? (
        <div className="answer stop" role="alert">
          <p className="said">Nothing was written.</p>
          <p className="because">{error}</p>
        </div>
      ) : null}
      {settled ? (
        <div className="answer ok">
          <p className="said">
            {settled === 'accepted'
              ? 'Settled. Enrichment is queued behind a run of its own.'
              : 'Recorded as not found.'}
          </p>
          <p className="because">
            The settlement was appended as a new attempt rather than replacing the last one, so both
            readings stay on the record.{' '}
            <Link href={`/program/${programId}/needs-review`}>Back to what is waiting</Link>.
          </p>
        </div>
      ) : (
        <div className={`answer ${answer.tone}`}>
          <p className="said">{answer.said}</p>
          <p className="because">{answer.because}</p>
        </div>
      )}

      {/* Quoted verbatim: the same sentence the resolver and evaluator carry. */}
      <section className="card">
        <h3 style={{ marginTop: 0 }}>The standard you are applying</h3>
        <p style={{ marginBottom: '0.5rem' }}>{IDENTITY_STANDARD}</p>
        <ul style={{ margin: 0, paddingLeft: '1.1rem' }} className="note">
          {IDENTITY_TRAPS.map((trap) => (
            <li key={trap}>{trap}</li>
          ))}
        </ul>
      </section>

      {shared.length > 0 ? (
        <>
          <h2>What the eight checks already settled</h2>
          <p className="note" style={{ margin: '-0.4rem 0 0.6rem', maxWidth: '56rem' }}>
            Stated once, above the list, because {shared.length === 1 ? 'it is' : 'they are'} true of
            every record below. Repeating {shared.length === 1 ? 'it' : 'them'} on each row is what
            made the old screen unreadable.
          </p>
          <Legend />
          <div className="card" style={{ marginBottom: '1.4rem' }}>
            <div className="vs">
              {shared.map((verdict) => (
                <span key={verdict.discriminator} className={`v ${tone(verdict.verdict)}`} title={verdict.reasoning}>
                  <i aria-hidden="true">{glyph(verdict.verdict)}</i> {label(verdict.discriminator)}
                  <span className="vh"> — {verdict.verdict}</span>
                </span>
              ))}
            </div>
          </div>
        </>
      ) : null}

      <h2>Which record settles it</h2>
      <p className="note" style={{ margin: '-0.4rem 0 0.8rem', maxWidth: '56rem' }}>
        Ordered by how much of each record is corroborated — distinct sources — and not by search
        rank. Search rank is why these are here; Sayari&rsquo;s score is not comparable between
        queries, so it is not evidence about which is right.
      </p>

      <form action={settleByHand}>
        <input type="hidden" name="supplierId" value={supplier.id} />
        <input type="hidden" name="programId" value={programId} />

        {groups.map((group) =>
          group.kind === 'listed' ? (
            group.choices.map((choice) => <Pick key={choice.entityId} choice={choice} programId={programId} />)
          ) : (
            <details className="same" key={group.summary} open>
              <summary>{group.summary}</summary>
              <p className="note" style={{ margin: '0 0 0.6rem' }}>
                Sayari links none of these by <span className="mono">possibly_same_as</span>, so the
                app cannot call them Twins — it can only say it cannot separate them. Settling on one
                leaves{' '}
                {group.choices.length === 2
                  ? 'the other unreferenced'
                  : `the other ${group.choices.length - 1} unreferenced`}
                , and that is the honest cost of settling here at all.
              </p>
              {group.choices.map((choice) => (
                <Pick key={choice.entityId} choice={choice} programId={programId} />
              ))}
            </details>
          ),
        )}

        {/* A stated choice, not an empty field: not found is a finding. */}
        <label className="pick out">
          <input type="radio" name="choice" value="not_found" required />
          <span>
            <span className="who">
              <strong>None of these — mark the row not found</strong>
            </span>
            <span className="note">
              <em>Not found</em> means no candidate is the roster company. It is a finding about the
              roster, and it is recorded as one — which is why it is a choice here rather than an
              empty box.
            </span>
          </span>
        </label>

        <details className="same">
          <summary>Settle on an id that is not listed</summary>
          <p className="note" style={{ margin: '0 0 0.6rem' }}>
            For a record found in Sayari&rsquo;s own interface that no rung reached. It is checked
            against the entity store before anything is written, and returned to you here if it does
            not resolve — only records this app has already fetched can be settled on.
          </p>
          <label className="pick">
            <input type="radio" name="choice" value="other" />
            <span>
              <span className="who">
                <strong>Use the id below</strong>
              </span>
              <input
                name="entityId"
                className="mono"
                placeholder="22-character entity id"
                aria-label="Sayari entity id"
                pattern="[A-Za-z0-9_-]{22}"
                style={{
                  marginTop: '0.4rem',
                  padding: '0.4rem',
                  border: '1px solid var(--rule)',
                  borderRadius: 4,
                  width: '100%',
                  maxWidth: '20rem',
                }}
              />
            </span>
          </label>
        </details>

        <div className="card" style={{ marginTop: '1rem' }}>
          <label className="note" htmlFor="note">
            Why — stored as a human round on the record
          </label>
          <input
            id="note"
            name="note"
            style={{
              display: 'block',
              margin: '0.3rem 0 0.8rem',
              padding: '0.4rem',
              border: '1px solid var(--rule)',
              borderRadius: 4,
              width: '100%',
              maxWidth: '40rem',
            }}
          />
          <button type="submit" className="btn primary">
            Settle on the selected record
          </button>
          <p className="note" style={{ margin: '0.8rem 0 0', maxWidth: '54rem' }}>
            Settling appends a new attempt rather than replacing the last one, so an override after
            an agent accept shows both. It opens a Run of its own — the enrichment it unblocks is
            attributable to your decision rather than to the run that could not settle this row.
          </p>
        </div>
      </form>

      {attempts.length > 0 ? (
        <details className="working" open={done}>
          <summary>
            What has already been tried — {attempts.length} attempt{attempts.length === 1 ? '' : 's'}
          </summary>
          <div className="scroll-x">
            <table>
              <caption className="note" style={{ captionSide: 'bottom', textAlign: 'left' }}>
                Append-only: an override after an agent accept shows both settlements.
              </caption>
              <thead>
                <tr>
                  <th scope="col" className="num">
                    #
                  </th>
                  <th scope="col">Outcome</th>
                  <th scope="col">Settled by</th>
                  <th scope="col">Rungs</th>
                  <th scope="col">Note</th>
                </tr>
              </thead>
              <tbody>
                {attempts.map((attempt) => (
                  <tr key={attempt.id}>
                    <td className="num">{attempt.attemptN}</td>
                    <td>{attempt.outcomeStatus.replace(/_/g, ' ')}</td>
                    <td>{attempt.settledBy}</td>
                    <td className="mono">
                      {Array.isArray(attempt.rungsUsed) ? attempt.rungsUsed.join(' ') : '—'}
                    </td>
                    <td>{attempt.note ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </main>
  );
}

/** One record, as a radio. The whole row is the label, so the row is the target. */
function Pick({ choice, programId }: { choice: Choice; programId: string }) {
  return (
    <label className={`pick ${choice.caution ? 'out' : ''}`}>
      <input type="radio" name="choice" value={`entity:${choice.entityId}`} required />
      <span>
        <span className="who">
          <strong>{choice.label}</strong>
          {choice.caution ? <span className="badge bad">{choice.caution}</span> : null}
          {choice.otherName ? <span className="badge">filed under another name</span> : null}
        </span>
        {choice.addressLine ? (
          <span className="facts addr">
            <span>
              <b>{choice.addressLine}</b>
            </span>
          </span>
        ) : null}
        <span className="facts">
          <span>
            city <b>{choice.city ?? '—'}</b>
          </span>
          <span>
            country <b>{choice.country ?? '—'}</b>
          </span>
          <span>
            sources <b>{choice.distinctSourceCount ?? '—'}</b>
          </span>
          <span>
            LEI <b>{choice.lei ?? 'none'}</b>
          </span>
          <span>
            found by <b>{choice.foundByRung}</b>
            {choice.queryProvenance ? ` — ${choice.queryProvenance}` : ''}
          </span>
        </span>
        {choice.verdicts.length > 0 ? (
          <span className="vs">
            {choice.verdicts.map((verdict) => (
              <Verdict key={verdict.discriminator} verdict={verdict} />
            ))}
          </span>
        ) : null}
        {choice.caution ? (
          <span className="note">
            <strong style={{ color: 'var(--bad)' }}>
              Strongest on every visible signal and still wrong.
            </strong>{' '}
            A depositary receipt is an instrument that trades against the company, not the company
            that would sign a contract. The Identity Standard names the brand and the division; a
            listing is the same exclusion by the same reasoning.{' '}
            <Link href={`/program/${programId}/entity/${choice.entityId}` as never}>
              Open the record
            </Link>
            .
          </span>
        ) : (
          <span className="note">
            <Link href={`/program/${programId}/entity/${choice.entityId}` as never}>
              Open the record
            </Link>
          </span>
        )}
      </span>
    </label>
  );
}

/**
 * A verdict, led by its glyph.
 *
 * ✓ / ✗ / ? come before the name and the colour follows, because a verdict that
 * is only a hue is a verdict a colour-blind reader has to guess at — and the
 * distinction this page turns on is `unavailable` against `fail`, which are the
 * two that must never blur. A disagreement between reporters keeps both.
 */
function Verdict({ verdict }: { verdict: ChoiceVerdict }) {
  if (verdict.disputed) {
    return (
      <span className="v split" title={verdict.reports.map((r) => `${r.reportedBy}: ${r.reasoning}`).join(' · ')}>
        <i aria-hidden="true">!</i> {label(verdict.discriminator)} — read two ways
        <span className="vh">
          {verdict.reports.map((r) => ` ${r.reportedBy} says ${r.verdict}.`).join('')}
        </span>
      </span>
    );
  }
  return (
    <span className={`v ${tone(verdict.verdict)}`} title={`${verdict.reportedBy.join(', ')}: ${verdict.reasoning}`}>
      <i aria-hidden="true">{glyph(verdict.verdict)}</i> {label(verdict.discriminator)}
      <span className="vh"> — {verdict.verdict}</span>
    </span>
  );
}

function Legend() {
  return (
    <p className="legend">
      <span className="v pass">
        <i aria-hidden="true">✓</i> passed
      </span>
      <span className="v fail">
        <i aria-hidden="true">✗</i> failed
      </span>
      <span className="v dunno">
        <i aria-hidden="true">?</i> can’t tell
      </span>
      <span className="note">
        — a verdict says which it is before it is coloured. <em>Can’t tell</em> is not a failure:
        absent evidence is not contrary evidence.
      </span>
    </p>
  );
}

const glyph = (verdict: string) => (verdict === 'pass' ? '✓' : verdict === 'fail' ? '✗' : '?');
const tone = (verdict: string) => (verdict === 'pass' ? 'pass' : verdict === 'fail' ? 'fail' : 'dunno');
const label = (discriminator: string) => discriminator.replace(/_/g, ' ');

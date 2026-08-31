import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { getPooledDb } from '@/db/client';
import * as t from '@/db/schema';
import { Breadcrumb } from '@/components/breadcrumb';
import { loadParked } from '@/db/queries/needs-review';

/**
 * Needs Review (SPEC §6.8) — a branch off the Programme page.
 *
 * **A list of decisions, one link each.** What stood here rendered every parked
 * row in full on one page: nine candidates for NSK and eight for Nemak, each
 * with its own copy of the same eight verdicts and its own free-text form. The
 * page was the settling screen repeated, so nothing on it could open with what
 * the reader had actually come to do.
 *
 * It is a list now, and the settling happens one row at a time on
 * `needs-review/[supplierId]` — which is also what lets that page carry a real
 * three-step trail back to here rather than the parent pointer the rest of the
 * app renders.
 *
 * A parked row never stalls a run: everything else finishes without it, which
 * is why this page can be a queue rather than a blockage.
 */
export default async function NeedsReviewPage({
  params,
}: {
  params: Promise<{ programId: string }>;
}) {
  const { programId } = await params;
  const db = getPooledDb();

  const program = await db.query.program.findFirst({ where: eq(t.program.id, programId) });
  if (!program) notFound();

  const waiting = await loadParked(db, programId);
  const decidable = waiting.filter((row) => row.candidateCount > 0).length;

  return (
    <main>
      <Breadcrumb
        trail={[{ label: program.name, href: `/program/${programId}` }, { label: 'Needs review' }]}
      />
      <h1>Needs review</h1>

      {waiting.length === 0 ? (
        <div className="answer ok">
          <p className="said">Nothing is waiting on you.</p>
          <p className="because">
            Every roster row is settled — by the resolver, by the evaluator agreeing with it, or by
            somebody here. <Link href={`/program/${programId}`}>Back to the programme</Link>.
          </p>
        </div>
      ) : (
        <>
          <div className="answer you">
            <p className="said">
              {waiting.length === 1
                ? 'One roster row is waiting on a decision only you can make.'
                : `${waiting.length} roster rows are waiting on a decision only you can make.`}
            </p>
            <p className="because">
              {decidable === waiting.length
                ? 'Each one found companies in the right country and could not tell which is the roster row’s. Two independent reads disagreed, which is the software declining to guess rather than failing.'
                : `${decidable} of them found companies in the right country and could not choose between them; the ${waiting.length - decidable} others never saw a candidate at all, and searching by hand may still find one.`}{' '}
              Nothing else is blocked by them — a parked row never stalls a run, and every other
              supplier finishes without it.
            </p>
          </div>

          <div className="scroll-x">
            <table>
              <caption className="note" style={{ captionSide: 'bottom', textAlign: 'left' }}>
                Roster order. Each row opens the records that were found for it.
              </caption>
              <thead>
                <tr>
                  <th scope="col" className="num">
                    Row
                  </th>
                  <th scope="col">Supplier</th>
                  <th scope="col">Where the roster says it is</th>
                  <th scope="col" className="num">
                    Records found
                  </th>
                  <th scope="col">What is being asked</th>
                </tr>
              </thead>
              <tbody>
                {waiting.map(({ supplier, match, candidateCount }) => (
                  <tr key={supplier.id}>
                    <td className="num">{supplier.rosterIndex}</td>
                    <td>
                      <Link href={`/program/${programId}/needs-review/${supplier.id}`}>
                        {supplier.rosterName}
                      </Link>
                      <div className="note">
                        <span className={`badge ${match.status === 'needs_review' ? 'warn' : 'bad'}`}>
                          {match.status.replace(/_/g, ' ')}
                        </span>
                      </div>
                    </td>
                    <td className="note">
                      {supplier.rosterAddress} · {supplier.rosterCountry}
                    </td>
                    <td className="num">{candidateCount}</td>
                    <td>
                      {/*
                        The two parked states mean different things: `needs
                        review` says a candidate in-country was seen and a
                        person can choose; `not found` says none ever was.
                      */}
                      {candidateCount > 0
                        ? `Choose between ${candidateCount} records, or say none of them is the company.`
                        : 'No candidate in this country was ever seen. Searching by hand may still find one.'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </main>
  );
}

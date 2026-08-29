import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { getPooledDb } from '@/db/client';
import * as t from '@/db/schema';
import { Breadcrumb } from '@/components/breadcrumb';

/**
 * The record page (SPEC §13.1) — **level five, the bottom of the spine**.
 *
 * This is where a Citation's record hop lands, and it is the reason
 * `sayari_get_record` is in the Dossier's six-tool profile: a Citation must
 * resolve to a **live local row**, and a record id seen inside an entity's
 * attributes has no local row until something fetched it. Without this page
 * there would be nothing at the bottom of the hop.
 */
export default async function RecordPage({
  params,
}: {
  params: Promise<{ programId: string; recordId: string }>;
}) {
  const { programId, recordId } = await params;
  const db = getPooledDb();

  const record = await db.query.record.findFirst({ where: eq(t.record.id, recordId) });
  if (!record) notFound();

  const program = await db.query.program.findFirst({ where: eq(t.program.id, programId) });

  return (
    <main>
      <Breadcrumb
        trail={[
          { label: program?.name ?? 'Programme', href: `/program/${programId}` },
          { label: 'Source record' },
        ]}
      />
      <h1>{record.sourceLabel ?? record.source ?? 'Source record'}</h1>
      <p className="sub mono">{record.id}</p>

      <div className="card">
        <table>
          <tbody>
            <tr><td>Source</td><td>{record.source ?? '—'}</td></tr>
            <tr>
              <td>Collected</td>
              <td>{record.collectedAt?.toISOString().slice(0, 10) ?? '—'}</td>
            </tr>
            <tr>
              <td>Published</td>
              <td>{record.publishedAt?.toISOString().slice(0, 10) ?? '—'}</td>
            </tr>
            <tr>
              <td>First seen here</td>
              {/*
                Never re-stamped on refresh: the *new evidence* staleness chip is
                computed from it, and re-stamping would silence the signal.
              */}
              <td>{record.firstSeenAt.toISOString().slice(0, 10)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {record.fields ? (
        <>
          <h2>Fields, as the source recorded them</h2>
          <div className="card scroll-x">
            <pre className="mono" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
              {JSON.stringify(record.fields, null, 2)}
            </pre>
          </div>
        </>
      ) : null}

      <p className="note" style={{ marginTop: '1rem' }}>
        <Link href={`/program/${programId}` as never}>← back to the programme</Link>
      </p>
    </main>
  );
}

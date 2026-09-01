import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getPooledDb } from '@/db/client';
import { loadRecordPage } from '@/db/queries/record-page';
import { Breadcrumb } from '@/components/breadcrumb';
import { ChatDock } from '@/components/chat-dock';

/**
 * The record page (SPEC §13.1) — **level five, the bottom of the spine**.
 *
 * This is where a Citation's record hop lands, and it is the reason
 * `sayari_get_record` is in the Dossier's six-tool profile: a Citation must
 * resolve to a **live local row**, and a record id seen inside an entity's
 * attributes has no local row until something fetched it. Without this page
 * there would be nothing at the bottom of the hop.
 *
 * ## A catch-all segment, because a record id contains slashes
 *
 * A Sayari record id is a three-part path:
 * `66dfefb726ae…/{93635462-94C0-…}/1672531200000` — source, record, timestamp.
 * A single `[recordId]` segment cannot hold it: percent-encoding the slashes
 * produces a URL that Next decodes back into extra path segments, and the route
 * 404s. Encoding harder does not help, because the decoding happens before the
 * route matches.
 *
 * `[...recordId]` takes the parts and rejoins them, which is what the id
 * actually is — a path. The braces are left percent-encoded by `encodeURI`,
 * which is correct: they are part of the record's own name, not structure.
 */
export default async function RecordPage({
  params,
}: {
  params: Promise<{ programId: string; recordId: string[] }>;
}) {
  const { programId, recordId: segments } = await params;

  const data = await loadRecordPage(getPooledDb(), { programId, segments });
  if (!data) notFound();
  const { record, program } = data;

  return (
    <main>
      <Breadcrumb
        trail={[
          { label: program?.name ?? 'Program', href: `/program/${programId}` },
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
        <Link href={`/program/${programId}` as never}>← back to the program</Link>
      </p>
      <ChatDock programId={programId} />
    </main>
  );
}

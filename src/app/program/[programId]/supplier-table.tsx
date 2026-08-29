import Link from 'next/link';
import type * as t from '@/db/schema';
import type { Facets } from '@/lib/view-state';

/**
 * The Programme's Supplier table.
 *
 * **A filtered row keeps its true position and is dimmed, never removed**
 * (SPEC §13.6). The filter is presentation; removing rows would make the crop
 * invisible, and the whole point is that it is not.
 *
 * The page states the crop once — *"showing 9 of 50"* — so a reader never has
 * to infer it from a short list.
 */
export function SupplierTable({
  programId,
  suppliers,
  matchBySupplier,
  assessedIds,
  facets,
}: {
  programId: string;
  suppliers: (typeof t.supplier.$inferSelect)[];
  matchBySupplier: Map<string, { status: string; entityId: string | null; settledBy: string }>;
  assessedIds: Set<string>;
  facets: Facets;
}) {
  const visible = (supplier: (typeof t.supplier.$inferSelect)) => {
    if (facets.country?.length && !facets.country.includes(supplier.rosterCountry ?? 'unknown')) return false;
    const status = matchBySupplier.get(supplier.id)?.status ?? 'unresolved';
    if (facets.matchStatus?.length && !facets.matchStatus.includes(status)) return false;
    return true;
  };

  const shown = suppliers.filter(visible).length;
  const filtered = shown !== suppliers.length;

  return (
    <>
      {filtered ? (
        <p className="note" style={{ marginBottom: '0.5rem' }}>
          Showing {shown} of {suppliers.length}. Hidden rows keep their place — the filter changes what
          you see, never what a recommendation argues from.{' '}
          <Link href={`/program/${programId}` as never}>Clear</Link>
        </p>
      ) : null}
      <div className="card scroll-x">
        <table>
          <thead>
            <tr>
              <th className="num">#</th>
              <th>Supplier</th>
              <th>Country</th>
              <th>Match</th>
              <th>Settled by</th>
              <th>Assessment</th>
            </tr>
          </thead>
          <tbody>
            {suppliers.map((supplier) => {
              const match = matchBySupplier.get(supplier.id);
              const isVisible = visible(supplier);
              return (
                <tr key={supplier.id} className={isVisible ? undefined : 'hidden-by-filter'}>
                  <td className="num">{supplier.rosterIndex ?? '—'}</td>
                  <td>
                    <Link href={`/program/${programId}/supplier/${supplier.id}` as never}>
                      {supplier.rosterName ?? '(promoted lead)'}
                    </Link>
                  </td>
                  <td>{supplier.rosterCountry ?? '—'}</td>
                  <td>
                    <MatchBadge status={match?.status} />
                  </td>
                  <td className="note">
                    {/* A promoted Lead reads "discovered", never "verified". */}
                    {match?.settledBy === 'discovered' ? 'discovered' : (match?.settledBy ?? '—')}
                  </td>
                  <td>
                    {assessedIds.has(supplier.id) ? (
                      <span className="badge good">assessed</span>
                    ) : (
                      <span className="badge mute">not yet</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function MatchBadge({ status }: { status: string | undefined }) {
  if (!status) return <span className="badge mute">not yet run</span>;
  if (status === 'accepted') return <span className="badge good">accepted</span>;
  // "needs review" means a candidate in-country was seen and a person can
  // choose; "not found" means none ever was. Different asks, different words.
  if (status === 'needs_review') return <span className="badge warn">needs review</span>;
  return <span className="badge bad">not found</span>;
}

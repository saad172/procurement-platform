import Link from 'next/link';
import type * as t from '@/db/schema';
import { dismiss, promote } from './lead-actions';

/**
 * The Leads table (SPEC §11), below the Shortlist on the Category page.
 *
 * Three rules are visible in the markup, because each one is about what the
 * table refuses to hide:
 *
 * - **`latestShipmentDate` is a displayed column, never a filter.** It is
 *   absent on 13 of 25 measured rows, so filtering on it would silently drop
 *   the majority.
 * - **The name-token flag is labelled, never hidden.** An unverified
 *   relationship presented as fact is worse than one presented as a question.
 * - **Dismissal persists** and is reversible behind a toggle, or the same nine
 *   freight forwarders return on every run.
 */
export function LeadsTable({
  programId,
  categoryId,
  categoryCode,
  leads,
  showDismissed,
}: {
  programId: string;
  categoryId: string;
  categoryCode: string;
  leads: { lead: typeof t.lead.$inferSelect; entity: typeof t.entity.$inferSelect }[];
  showDismissed: boolean;
}) {
  const visible = leads.filter((row) => showDismissed || !row.lead.dismissed);

  return (
    <>
      <h2>
        Leads{' '}
        <span className="note">
          companies shipping this category’s HS lines that are on no imported list
        </span>
      </h2>

      <div className="card scroll-x">
        {visible.length === 0 ? (
          <p className="empty">
            No leads yet. Discover reads trade data for this category’s HS lines and proposes
            companies — it never adds one. Promotion is a person’s act.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Company</th>
                <th>Classification</th>
                <th className="num">Shipments</th>
                <th>Latest shipment</th>
                <th>Relation</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visible.map(({ lead, entity }) => (
                <tr key={lead.id} className={lead.dismissed ? 'hidden-by-filter' : undefined}>
                  <td>
                    <Link href={`/program/${programId}/entity/${entity.id}` as never}>
                      {entity.label}
                    </Link>
                    <div className="note">{entity.country ?? 'country unknown'}</div>
                  </td>
                  <td>
                    <ClassificationBadge value={lead.classification} />
                    {lead.classificationReasoning ? (
                      <div className="note" title={lead.classificationReasoning}>
                        {lead.classificationReasoning.slice(0, 70)}…
                      </div>
                    ) : null}
                  </td>
                  <td className="num">{lead.shipmentCount?.toLocaleString('en-US') ?? '—'}</td>
                  <td className="note">
                    {/* Displayed, never filtered — absent on most rows. */}
                    {lead.latestShipmentDate ?? 'not recorded'}
                  </td>
                  <td>
                    {lead.relationVerified ? (
                      <span className="badge good" title="Found in an accepted supplier's ownership family">
                        related by ownership · verified
                      </span>
                    ) : lead.relatedSupplierId ? (
                      <span className="badge warn">possibly related · name match, unverified</span>
                    ) : (
                      <span className="note">—</span>
                    )}
                  </td>
                  <td>
                    {lead.promotedSupplierId ? (
                      <Link href={`/program/${programId}/supplier/${lead.promotedSupplierId}` as never}>
                        promoted
                      </Link>
                    ) : lead.dismissed ? (
                      <form action={dismiss}>
                        <input type="hidden" name="leadId" value={lead.id} />
                        <input type="hidden" name="programId" value={programId} />
                        <input type="hidden" name="categoryId" value={categoryId} />
                        <input type="hidden" name="undo" value="true" />
                        <button type="submit" className="badge mute" style={{ cursor: 'pointer' }}>
                          undismiss
                        </button>
                      </form>
                    ) : (
                      <div style={{ display: 'flex', gap: '0.3rem' }}>
                        <form action={promote}>
                          <input type="hidden" name="leadId" value={lead.id} />
                          <input type="hidden" name="programId" value={programId} />
                          <input type="hidden" name="categoryId" value={categoryId} />
                          {/* The seeding Category is pre-checked and confirmed
                              by a person, which keeps supplier_category
                              hand-authored in the sense the seed cared about. */}
                          <input type="hidden" name="categoryIds" value={categoryId} />
                          <button type="submit" className="badge good" style={{ cursor: 'pointer' }}>
                            promote to {categoryCode}
                          </button>
                        </form>
                        <form action={dismiss}>
                          <input type="hidden" name="leadId" value={lead.id} />
                          <input type="hidden" name="programId" value={programId} />
                          <input type="hidden" name="categoryId" value={categoryId} />
                          <button type="submit" className="badge mute" style={{ cursor: 'pointer' }}>
                            dismiss
                          </button>
                        </form>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="note">
        <Link
          href={`/program/${programId}/category/${categoryId}${showDismissed ? '' : '?dismissed=1'}` as never}
        >
          {showDismissed ? 'hide dismissed' : 'show dismissed'}
        </Link>
        {' · '}
        A promoted lead is recorded as <strong>discovered</strong>, never as <em>verified</em>: no name
        matching happened for it to be strong or weak at.
      </p>
    </>
  );
}

/**
 * The closed enum, rendered.
 *
 * **`unclear` is a real answer and is often the right one** — a guess dressed
 * as a classification is worse than an admission, because a person reviewing
 * leads can act on "unclear" and cannot act on a confident mistake.
 */
function ClassificationBadge({ value }: { value: string | null }) {
  if (!value) return <span className="badge mute">not classified</span>;
  if (value === 'manufacturer') return <span className="badge good">manufacturer</span>;
  if (value === 'unclear') return <span className="badge warn">unclear</span>;
  return <span className="badge mute">{value.replace(/_/g, ' ')}</span>;
}

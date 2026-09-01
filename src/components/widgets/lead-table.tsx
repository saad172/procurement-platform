import Link from 'next/link';
import { z } from 'zod/v4';
import { RawPayload } from './raw';

/**
 * `lead_table` — mirrors `LeadsTable` (classification, shipments, relation)
 * without its promote/dismiss actions: chat proposes and never does.
 *
 * `list_leads` selects bare `lead` rows with no join to `entity`, so there is
 * no company name and no country in this payload — only `entityId`, which is
 * what the link is built from and what stands in for the name.
 */

const leadSchema = z.object({
  id: z.string(),
  programId: z.string(),
  entityId: z.string(),
  classification: z.string().nullable(),
  shipmentCount: z.number().nullable(),
  latestShipmentDate: z.string().nullable(),
  relatedSupplierId: z.string().nullable().optional(),
  relationVerified: z.boolean(),
  dismissed: z.boolean(),
  promotedSupplierId: z.string().nullable().optional(),
});
const payloadSchema = z.array(leadSchema);
type Lead = z.infer<typeof leadSchema>;

export function LeadTableWidget({ payload }: { payload: unknown }) {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) return <RawPayload payload={payload} />;
  const rows = parsed.data;
  if (rows.length === 0) return <p className="empty">No leads yet.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>Company</th>
          <th>Classification</th>
          <th className="num">Shipments</th>
          <th>Relation</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((l) => (
          <LeadRow key={l.id} l={l} />
        ))}
      </tbody>
    </table>
  );
}

function LeadRow({ l }: { l: Lead }) {
  return (
    <tr className={l.dismissed ? 'hidden-by-filter' : undefined}>
      <td>
        <Link href={`/program/${l.programId}/entity/${l.entityId}` as never}>{l.entityId}</Link>
        {l.dismissed ? <div className="note">dismissed</div> : null}
        {l.promotedSupplierId ? (
          <div className="note">
            <Link href={`/program/${l.programId}/supplier/${l.promotedSupplierId}` as never}>
              promoted
            </Link>
          </div>
        ) : null}
      </td>
      <td>
        {l.classification ? (
          <span className={`badge ${l.classification === 'manufacturer' ? 'good' : 'mute'}`}>
            {l.classification.replace(/_/g, ' ')}
          </span>
        ) : (
          <span className="badge mute">not classified</span>
        )}
      </td>
      <td className="num">
        {l.shipmentCount?.toLocaleString('en-US') ?? '—'}
        <div className="note">{l.latestShipmentDate ?? 'not recorded'}</div>
      </td>
      <td>
        {l.relationVerified ? (
          <span className="badge good">related by ownership · verified</span>
        ) : l.relatedSupplierId ? (
          <span className="badge warn">possibly related · unverified</span>
        ) : (
          <span className="note">—</span>
        )}
      </td>
    </tr>
  );
}

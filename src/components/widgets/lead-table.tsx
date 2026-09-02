import Link from 'next/link';
import { z } from 'zod/v4';
import { leadClassificationLabel, leadRelation } from '@/domain/lead-answer';
import { RawPayload } from './raw';

/**
 * `lead_table` — the Category page's `LeadsTable`
 * (`src/app/program/[programId]/category/[categoryId]/leads.tsx`), minus its
 * `LeadActions` — chat proposes and never promotes or dismisses a Lead
 * itself, the same discipline `settleMatch()` enforces for a Match (SPEC
 * §2.4).
 *
 * `list_leads` selects bare `lead` rows with no join to `entity` (finding
 * 103): `LeadsTable`'s own rows carry both, so its column reads a company
 * name and country and this one cannot — every row here is named by its
 * Sayari `entityId` instead, which is what the link is built from too.
 * `latestShipmentDate` stays a displayed column and never a filter, the same
 * rule the page states for the same reason: it is absent on roughly half the
 * roster, so filtering on it would silently drop the majority.
 */

const leadSchema = z.object({
  id: z.string(),
  programId: z.string(),
  entityId: z.string(),
  classification: z.string().nullable(),
  /** Why there is none, when there is none — never the word `unclear`. */
  notClassifiedReason: z.string().nullable().optional(),
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
  // Falls back rather than throws: a widget frozen onto a message outlives
  // the shape this schema names (finding 103).
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

/** One row: the entity link standing in for a name, then classification, volume, and how it relates to an existing Supplier. */
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
        <ClassificationBadge l={l} />
      </td>
      <td className="num">
        {l.shipmentCount?.toLocaleString('en-US') ?? '—'}
        <div className="note">{l.latestShipmentDate ?? 'not recorded'}</div>
      </td>
      <td>
        <RelationBadge l={l} />
      </td>
    </tr>
  );
}

/**
 * The classification, or why there is none.
 *
 * Shares `leadClassificationLabel` with the Category page for the reason the
 * relation badge shares `leadRelation`: this widget already drifted from the
 * page once. A Lead with no classification says *not classified: <reason>*
 * rather than `unclear`, because a classifier that hit its cap made no
 * judgement and *unclear* is a judgement.
 */
function ClassificationBadge({ l }: { l: Lead }) {
  const label = leadClassificationLabel(l);
  if (label.kind === 'not_classified') {
    return (
      <span className="badge mute" title={label.title ?? undefined}>
        {label.label}
      </span>
    );
  }
  return (
    <span className={`badge ${label.manufacturer ? 'good' : 'mute'}`}>{label.label}</span>
  );
}

/**
 * `leadRelation()` (`@/domain/lead-answer`) owns the wording, shared with
 * `LeadsTable`'s `RelationBadge` — this widget used to drop "name match" from
 * the unverified label, one word the page kept, before the two read one
 * definition.
 */
function RelationBadge({ l }: { l: Lead }) {
  const relation = leadRelation(l);
  if (relation.kind === 'verified') return <span className="badge good">{relation.label}</span>;
  if (relation.kind === 'unverified') return <span className="badge warn">{relation.label}</span>;
  return <span className="note">—</span>;
}

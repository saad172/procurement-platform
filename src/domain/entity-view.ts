import type { SayariEntity } from '@/upstream/projections/sayari';

/**
 * What a model sees when it fetches an entity.
 *
 * ## Why a projection exists at all
 *
 * A Sayari entity is not a record, it is a graph node with every edge attached.
 * Yazaki's carries 88 221 `carrier_of` relationships, 4 369 `notify_party_of`,
 * nineteen addresses and a full source list. Handed over whole, three
 * `sayari_get_entity` calls put **703 956 tokens** through a resolve Round and
 * the 400 000-token ceiling fired — correctly, on a Round that had already
 * produced a usable proposal.
 *
 * This is the same defect the traversal paths had: an upstream shape that is
 * right for a graph API and wrong for a prompt. The fix is the same one —
 * **carry the shape, not the contents**.
 *
 * ## What survives, and why
 *
 * Everything a Discriminator reads, everything a Citation can point at, and the
 * counts that tell an agent whether to look further:
 *
 * - identity — id, label, type, country, the URL a person would open
 * - the **addresses**, which is where the Bosch decoy is settled (Gerlingen is
 *   the twelfth of nineteen, so a first-address-only view answers wrongly)
 * - identifiers, so an LEI can be joined against GLEIF
 * - the risk factors, with level and traversal path, which are the point of
 *   Compliance
 * - `relationship_count`, an object keyed by relation type — a hundred bytes
 *   that says what the 88 221 rows would have said
 *
 * ## What is dropped, and how to get it back
 *
 * The relationship **rows**, the `possibly_same_as` block, and the raw source
 * list. Each has its own tool: the family is `get_supplier_family`, a specific
 * record is `sayari_get_record`. A tool that returned everything would make
 * those tools pointless and the ceiling unreachable.
 */

/** Addresses beyond this are truncated, and the count says so. */
const MAX_ADDRESSES = 25;

/** Risk factors are the point of the call, so the cap is generous. */
const MAX_RISK_FACTORS = 40;

export type EntityView = {
  id: string;
  label: string;
  type: string | null;
  country: string | null;
  entityUrl: string | null;
  sanctioned: boolean | null;
  pep: boolean | null;
  closed: boolean | null;
  companyType: string | null;
  registrationDate: string | null;
  /** Capped; `addressCount` is the true total. */
  addresses: string[];
  addressCount: number;
  identifiers: unknown[];
  /** How many source records back this entity — a number, not the object. */
  sourceCount: number;
  /** Keyed by relation type. The rows themselves are another tool's job. */
  relationshipCount: Record<string, number>;
  /** Records this entity is a possible-same-as of, as a count only. */
  psaCount: number | null;
  risk: { factor: string; level: string | null; traversalPath: string[] | null }[];
  riskFactorCount: number;
  /** Named so a reader knows the view is partial by design, not by accident. */
  omitted: string[];
};

export function toEntityView(entity: SayariEntity): EntityView {
  const addresses = entity.addresses ?? [];
  const riskEntries = Object.entries(entity.risk ?? {});

  return {
    id: entity.id,
    label: entity.label,
    type: entity.type ?? null,
    country: entity.countries?.[0] ?? null,
    entityUrl: entity.entity_url ?? null,
    sanctioned: entity.sanctioned ?? null,
    pep: entity.pep ?? null,
    closed: entity.closed ?? null,
    companyType: entity.company_type ?? null,
    registrationDate: entity.registration_date ?? null,
    addresses: addresses.slice(0, MAX_ADDRESSES),
    addressCount: addresses.length,
    identifiers: entity.identifiers ?? [],
    // `source_count` is an OBJECT keyed by source hash, not a scalar — its size
    // is the number, and the hashes say nothing a model can use.
    sourceCount: Object.keys(entity.source_count ?? {}).length,
    relationshipCount: entity.relationship_count ?? {},
    psaCount: entity.psa_count ?? null,
    risk: riskEntries.slice(0, MAX_RISK_FACTORS).map(([factor, value]) => ({
      factor,
      level: value?.level ?? null,
      // The projection types this loosely because the upstream shape varies by
      // factor; a path is a list of `id|relation|id` strings when present.
      traversalPath: Array.isArray(value?.metadata?.traversal_path)
        ? (value.metadata.traversal_path as string[])
        : null,
    })),
    riskFactorCount: riskEntries.length,
    omitted: omissions(entity, addresses.length, riskEntries.length),
  };
}

/**
 * Says what was left out, in the payload itself.
 *
 * A truncated list that does not announce its truncation is how a model comes
 * to write *"the entity has 25 addresses"*. The count fields carry the truth;
 * this carries the instruction for getting the rest.
 */
function omissions(entity: SayariEntity, addressCount: number, riskCount: number): string[] {
  const omitted: string[] = [];

  const relationshipRows = entity.relationships?.data?.length ?? 0;
  if (relationshipRows > 0) {
    omitted.push(
      'relationship rows — use get_supplier_family for ownership, or the counts above for volume',
    );
  }
  if ((entity.possibly_same_as?.data?.length ?? 0) > 0) {
    omitted.push('possibly-same-as records — psaCount above is their number');
  }
  if (addressCount > MAX_ADDRESSES) {
    omitted.push(`${addressCount - MAX_ADDRESSES} further address(es) — addressCount is the total`);
  }
  if (riskCount > MAX_RISK_FACTORS) {
    omitted.push(
      `${riskCount - MAX_RISK_FACTORS} further risk factor(s) — riskFactorCount is the total`,
    );
  }
  return omitted;
}

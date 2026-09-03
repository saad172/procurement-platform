/**
 * Whether a stored `entity.getEntity` `upstream_response.params` blob is the
 * FULL entity body Sayari can return for this id, rather than a
 * relationship-filtered read (ticket 01/02 review item N2).
 *
 * `getEntityQuery`'s `relationships*` filter params (`src/upstream/
 * endpoints.ts`) were widened past the eleven `GET_ENTITY_LIMITS` to admit
 * `relationshipsType`/`relationshipsSort`/etc — SPEC §16.6's typed owner-edge
 * read. Several readers treat ANY stored `entity.getEntity` row for an id as
 * "the entity body is cached" or "the newest getEntity row is the full
 * payload": `cachedUpstreamFor` (`src/tools/catalog/enqueues.ts`),
 * `backfillProvenance` (`scripts/reproject-relationships.ts`),
 * `scripts/reproject-entities.ts` and `scripts/remeasure-discriminators.ts`.
 * A filtered read narrows what came back — fewer relationships, sometimes
 * none — so treating one as the full body would be wrong exactly the way a
 * cache read that ignores its own filter is wrong.
 *
 * `relationshipsLimit` is exempt: it is one of `GET_ENTITY_LIMITS`, applied
 * to every `getEntity` call and therefore present, at its default, on every
 * stored row whether or not anything else filtered it — so its presence
 * alone says nothing about fullness.
 *
 * Latent today: no caller in this repo sends any of the other
 * `relationships*` params to `getEntity` yet (SPEC §16.6's typed read uses
 * `traversal.traversal` instead), so every row currently in the database
 * passes. Written now so the four readers above do not have to be re-audited
 * the day a caller does.
 */

export const RELATIONSHIP_FILTER_PARAM_KEYS = [
  'relationshipsType',
  'relationshipsSort',
  'relationshipsStartDate',
  'relationshipsEndDate',
  'relationshipsMinShares',
  'relationshipsCountry',
  'relationshipsArrivalCountry',
  'relationshipsArrivalState',
  'relationshipsArrivalCity',
  'relationshipsDepartureCountry',
  'relationshipsDepartureState',
  'relationshipsDepartureCity',
  'relationshipsPartnerName',
  'relationshipsPartnerRisk',
  'relationshipsHsCode',
] as const;

export function isFullEntityFetch(params: unknown): boolean {
  if (!params || typeof params !== 'object') return true;
  const row = params as Record<string, unknown>;
  return RELATIONSHIP_FILTER_PARAM_KEYS.every((key) => row[key] === undefined);
}

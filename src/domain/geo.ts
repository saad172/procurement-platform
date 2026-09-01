/**
 * Distance, for the proximity Criterion (SPEC §9.2).
 *
 * **Haversine, not routing.** A great-circle distance between two points that
 * are each a city centroid ±5 km does not become more honest by being routed
 * along roads — it becomes more precise-looking, which is worse.
 */

import { PROXIMITY_ANCHOR_MAX_KM } from './scoring/anchors';

const EARTH_RADIUS_KM = 6371;

export type Point = { lat: number; lon: number };

export function haversineKm(a: Point, b: Point): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export type PlantPoint = Point & { code: string; city: string };

/**
 * The nearest Plant, or nothing.
 *
 * Returning `undefined` rather than a sentinel distance matters: proximity is
 * `unknown` when there is no coordinate, and `unknown` drops out of the Score
 * rather than taking a stand-in value.
 */
export function nearestPlant(
  supplier: Point | undefined,
  plants: readonly PlantPoint[],
): { code: string; city: string; km: number } | undefined {
  if (!supplier || plants.length === 0) return undefined;
  let best: { code: string; city: string; km: number } | undefined;
  for (const plant of plants) {
    const km = haversineKm(supplier, plant);
    if (!best || km < best.km) best = { code: plant.code, city: plant.city, km };
  }
  return best;
}

/**
 * The three distance bands, and why there are exactly three.
 *
 * Not chosen — **measured**. `PROXIMITY_ANCHOR_MAX_KM`'s own note records the
 * roster at 14 rows in 48–824 km, 20 in 6 082–7 039 km and 16 in
 * 10 102–11 878 km, with **nothing at all between 824 km and 6 082 km**. Three
 * clusters separated by a 5 000 km void is three bands; a continuous ramp would
 * invent detail across a gap where the roster has no companies.
 *
 * The far edge is the anchor itself, because beyond it proximity scores 0 —
 * the band boundary is where the Criterion stops discriminating rather than an
 * arbitrary round number.
 */
export const NEAR_BAND_MAX_KM = 1_000;

export type ProximityBand = 'near' | 'mid' | 'far';

export const PROXIMITY_BANDS: readonly ProximityBand[] = ['near', 'mid', 'far'];

export function proximityBand(km: number): ProximityBand {
  if (km <= NEAR_BAND_MAX_KM) return 'near';
  if (km <= PROXIMITY_ANCHOR_MAX_KM) return 'mid';
  return 'far';
}

/**
 * Band labels are ranges, never ceilings: "under 8 000 km" is equally true of
 * the near band, and a legend whose entries are not disjoint is worse than no
 * legend at all.
 */
export function proximityBandLabel(band: ProximityBand): string {
  const near = NEAR_BAND_MAX_KM.toLocaleString('en-US');
  const far = PROXIMITY_ANCHOR_MAX_KM.toLocaleString('en-US');
  if (band === 'near') return `under ${near} km`;
  if (band === 'mid') return `${near}–${far} km`;
  return `beyond ${far} km`;
}

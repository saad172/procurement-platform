/**
 * Distance, for the proximity Criterion (SPEC §9.2).
 *
 * **Haversine, not routing.** A great-circle distance between two points that
 * are each a city centroid ±5 km does not become more honest by being routed
 * along roads — it becomes more precise-looking, which is worse.
 */

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

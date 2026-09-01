import Link from 'next/link';
import type * as t from '@/db/schema';
import {
  NEAR_BAND_MAX_KM,
  nearestPlant,
  proximityBand,
  proximityBandLabel,
  PROXIMITY_BANDS,
  type ProximityBand,
} from '@/domain/geo';
import { MapViewport, type Camera } from './map-viewport';
import type { Mark } from './map-marks';
import world from './world-110m.json';

/**
 * The four Program charts (SPEC §13.2).
 *
 * All four survive, each answering a question the Category table cannot. **The
 * charts are the filter control** — there is no separate filter UI, because
 * view state lives in the URL and a filter is therefore a link.
 *
 * Two rules run through all of them:
 *
 * - **The acted-on facet keeps its full distribution**, with the selection
 *   highlighted; everything else narrows. Otherwise clicking Germany collapses
 *   the very chart you would use to change your mind.
 * - A **map region preset is a camera, not a facet**: it moves the viewport and
 *   must not remove Suppliers from the table below.
 *
 * Drawn as inline SVG and CSS bars rather than with a charting library: four
 * charts of this simplicity do not justify a dependency, and a bar whose width
 * is a percentage is a bar anybody can read the source of.
 */

type Supplier = typeof t.supplier.$inferSelect;
type MatchRow = { supplierId: string; status: string; entityId: string | null; settledBy: string };

/**
 * A link that toggles one facet value, **keeping every other parameter**.
 *
 * `search` is the page's current query string, and it is not optional
 * decoration: without it a chart click silently discarded the weight rail's
 * what-if and the map's camera, so clicking a band would have thrown you back
 * to the world view mid-investigation. The comment here claimed this behaviour
 * before the parameter existed to deliver it.
 */
function facetHref(
  programId: string,
  facet: string,
  value: string,
  active: readonly string[],
  search: string,
): string {
  const next = active.includes(value) ? active.filter((v) => v !== value) : [...active, value];
  const params = new URLSearchParams(search);
  if (next.length > 0) params.set(facet, next.join(','));
  else params.delete(facet);
  params.set('from', `${facet}_chart`);
  const query = params.toString();
  return `/program/${programId}${query ? `?${query}` : ''}`;
}

// ── 1. Country breakdown — where the roster is ───────────────────────────────

export function CountryBreakdown({
  programId,
  suppliers,
  active,
  search,
}: {
  programId: string;
  suppliers: Supplier[];
  active: string[];
  search: string;
}) {
  const counts = new Map<string, number>();
  for (const supplier of suppliers) {
    const country = supplier.rosterCountry ?? 'unknown';
    counts.set(country, (counts.get(country) ?? 0) + 1);
  }
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const max = Math.max(...rows.map(([, n]) => n), 1);

  return (
    <section className="card">
      <h3>Where the roster is</h3>
      {rows.map(([country, count]) => (
        <Link
          key={country}
          href={facetHref(programId, 'country', country, active, search) as never}
          style={{
            display: 'block',
            color: 'inherit',
            textDecoration: 'none',
            marginBottom: '0.3rem',
          }}
        >
          <div
            style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', fontSize: '0.85rem' }}
          >
            <span style={{ width: '3rem', fontWeight: active.includes(country) ? 700 : 400 }}>
              {country}
            </span>
            <span className="bar" style={{ flex: 1 }}>
              <i
                style={{
                  width: `${(count / max) * 100}%`,
                  opacity: active.length === 0 || active.includes(country) ? 1 : 0.3,
                }}
              />
            </span>
            <span className="num" style={{ width: '2rem', textAlign: 'right' }}>
              {count}
            </span>
          </div>
        </Link>
      ))}
      <p className="note" style={{ marginTop: '0.6rem' }}>
        42 of 50 rows are G7 origins, so country resilience discriminates weakly here — which is why
        it is normalised on a fixed scale rather than stretched across the roster.
      </p>
    </section>
  );
}

// ── 2. Match outcomes — whether resolution worked ────────────────────────────

export function MatchOutcomes({
  programId,
  suppliers,
  matchBySupplier,
  active,
  search,
}: {
  programId: string;
  suppliers: Supplier[];
  matchBySupplier: Map<string, MatchRow>;
  active: string[];
  search: string;
}) {
  const buckets: Record<string, number> = {
    accepted: 0,
    needs_review: 0,
    not_found: 0,
    unresolved: 0,
  };
  const settledBy: Record<string, number> = {};
  for (const supplier of suppliers) {
    const match = matchBySupplier.get(supplier.id);
    buckets[match?.status ?? 'unresolved'] = (buckets[match?.status ?? 'unresolved'] ?? 0) + 1;
    if (match) settledBy[match.settledBy] = (settledBy[match.settledBy] ?? 0) + 1;
  }

  const label: Record<string, string> = {
    accepted: 'accepted',
    needs_review: 'needs review',
    not_found: 'not found',
    unresolved: 'not yet run',
  };

  return (
    <section className="card">
      <h3>Whether resolution worked</h3>
      {Object.entries(buckets).map(([status, count]) => (
        <Link
          key={status}
          href={facetHref(programId, 'matchStatus', status, active, search) as never}
          style={{
            display: 'block',
            color: 'inherit',
            textDecoration: 'none',
            marginBottom: '0.3rem',
          }}
        >
          <div
            style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', fontSize: '0.85rem' }}
          >
            <span style={{ width: '7rem', fontWeight: active.includes(status) ? 700 : 400 }}>
              {label[status]}
            </span>
            <span className="bar" style={{ flex: 1 }}>
              <i
                style={{
                  width: `${(count / Math.max(suppliers.length, 1)) * 100}%`,
                  opacity: active.length === 0 || active.includes(status) ? 1 : 0.3,
                }}
              />
            </span>
            <span className="num" style={{ width: '2rem', textAlign: 'right' }}>
              {count}
            </span>
          </div>
        </Link>
      ))}
      {settledBy.rules ? (
        <p className="note" style={{ marginTop: '0.6rem' }}>
          {/*
            The cheapest honest efficiency number this build produces (§18.5):
            settled by plain code, with no model involved at all.
          */}
          {settledBy.rules} settled by rules — 0 tokens
          {settledBy.agents ? ` · ${settledBy.agents} by the agents` : ''}
          {settledBy.human ? ` · ${settledBy.human} by a person` : ''}
        </p>
      ) : null}
    </section>
  );
}

// ── 3. Suppliers vs Plants — how far from the Plants ─────────────────────────

/**
 * One fixed world coordinate space, and every camera is a rectangle inside it.
 *
 * The whole world is projected **once**, on the server, and the SVG `viewBox`
 * does the framing. That is what lets a named camera work with JavaScript off,
 * lets pan and zoom be arithmetic on four numbers rather than a re-projection,
 * and keeps `world-110m.json` on the server — the browser is sent marks, never
 * geometry.
 */
const WORLD_BOX = [-180, -60, 180, 78] as const;
const WORLD_W = 100;
const WORLD_H = ((WORLD_BOX[3] - WORLD_BOX[1]) / (WORLD_BOX[2] - WORLD_BOX[0])) * WORLD_W;

/**
 * The tightest camera, in degrees of longitude.
 *
 * A **precision** limit, not a rendering one. Every Supplier coordinate is a
 * registered address and every Plant a city centroid ±5 km; below roughly this
 * width a dot is drawn smaller than its own error bar and begins to assert a
 * street corner. `geo.ts` refuses to route distances along roads for the same
 * reason — it would be more precise-looking, which is worse.
 */
const MIN_CAMERA_DEG = 12;

/** Degrees are square in this projection: 360° over 100 units, 138° over 38.3. */
const UNITS_PER_DEGREE = WORLD_W / (WORLD_BOX[2] - WORLD_BOX[0]);
const KM_PER_DEGREE = 111;

const REGIONS = [
  { key: 'world', label: 'World', box: WORLD_BOX },
  { key: 'north-america', label: 'N. America', box: [-130, 14, -60, 55] },
  { key: 'europe', label: 'Europe', box: [-12, 35, 32, 62] },
  { key: 'east-asia', label: 'E. Asia', box: [95, 18, 148, 48] },
] as const;

const BAND_FILL: Record<ProximityBand, string> = {
  near: 'var(--good)',
  mid: 'var(--warn)',
  far: 'var(--bad)',
};

const lonToWorld = (lon: number) =>
  ((lon - WORLD_BOX[0]) / (WORLD_BOX[2] - WORLD_BOX[0])) * WORLD_W;
const latToWorld = (lat: number) =>
  ((WORLD_BOX[3] - lat) / (WORLD_BOX[3] - WORLD_BOX[1])) * WORLD_H;

/** A region box as a camera in world units, with the world's aspect kept. */
function cameraFor(box: readonly [number, number, number, number]): Camera {
  const x = lonToWorld(box[0]);
  const w = lonToWorld(box[2]) - x;
  const h = w * (WORLD_H / WORLD_W);
  // Centred on the box's own latitude span: a region's aspect rarely matches
  // the world's, and letting the height follow the width keeps degrees square.
  const midY = (latToWorld(box[1]) + latToWorld(box[3])) / 2;
  return { x, y: Math.min(Math.max(midY - h / 2, 0), WORLD_H - h), w, h };
}

export type SupplierPoint = {
  id: string;
  name: string;
  country: string;
  status: string;
  assessed: boolean;
  lat: number;
  lon: number;
};

/**
 * Every ring, every time. Clipping to the current camera would be cheaper by
 * about a third, and would leave nothing to pan into.
 *
 * Pure: reads no component state, so `SupplierMap` can call it once per
 * render without a `useMemo` to reason about.
 */
function projectCountryPaths(features: { id: string; r: number[][] }[]): string[] {
  const paths: string[] = [];
  for (const country of features) {
    for (const ring of country.r) {
      let d = '';
      for (let i = 0; i < ring.length; i += 2) {
        d += `${i === 0 ? 'M' : 'L'}${lonToWorld(ring[i]!).toFixed(2)} ${latToWorld(ring[i + 1]!).toFixed(2)}`;
      }
      paths.push(`${d}Z`);
    }
  }
  return paths;
}

type PlantPoint = { code: string; city: string; lat: number; lon: number };
type Placed = {
  supplier: SupplierPoint;
  nearest: ReturnType<typeof nearestPlant>;
  band: ProximityBand | undefined;
};

/** Each Supplier matched to its nearest Plant and the band that distance falls in. */
function placeSuppliers(suppliers: SupplierPoint[], plantPoints: PlantPoint[]): Placed[] {
  return suppliers.map((supplier) => {
    const nearest = nearestPlant({ lat: supplier.lat, lon: supplier.lon }, plantPoints);
    return { supplier, nearest, band: nearest ? proximityBand(nearest.km) : undefined };
  });
}

/**
 * The mark payload: already projected, already measured. The browser is sent
 * positions and numbers, never coordinates to re-project or geometry to
 * re-draw — about 4 KB for 46 suppliers.
 */
function toMarks(placed: Placed[]): Mark[] {
  return placed.map(({ supplier, nearest, band }) => ({
    id: supplier.id,
    name: supplier.name,
    x: lonToWorld(supplier.lon),
    y: latToWorld(supplier.lat),
    band: band ?? null,
    km: nearest ? Math.round(nearest.km) : null,
    plant: nearest ? `${nearest.code} · ${nearest.city}` : null,
    country: supplier.country,
    status: supplier.status,
    assessed: supplier.assessed,
  }));
}

/**
 * The near-band ring: 1 000 km of real ground, drawn in map units and
 * therefore NOT counter-scaled — it is a distance, so it must grow when you
 * zoom the way a distance does. An ellipse rather than a circle because
 * equirectangular stretches longitude by 1/cos(lat), and a true circle drawn
 * as one here would misstate where the band falls. It answers the question
 * the colours raise: a dot is green *because it sits inside one of these*.
 */
function ProximityRings({ plants }: { plants: (typeof t.plant.$inferSelect)[] }) {
  return (
    <g
      className="map-bands"
      fill="none"
      stroke="var(--accent)"
      strokeOpacity={0.4}
      strokeDasharray="1.2 1.2"
    >
      {plants.map((plant) => (
        <ellipse
          key={plant.id}
          cx={lonToWorld(plant.lon)}
          cy={latToWorld(plant.lat)}
          rx={
            (NEAR_BAND_MAX_KM / (KM_PER_DEGREE * Math.cos((plant.lat * Math.PI) / 180))) *
            UNITS_PER_DEGREE
          }
          ry={(NEAR_BAND_MAX_KM / KM_PER_DEGREE) * UNITS_PER_DEGREE}
          strokeWidth={0.6}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </g>
  );
}

/**
 * Plants last and largest. Four fixed points are what every distance on this
 * map is measured from, and they are drawn after the Supplier marks so a
 * cluster of bidders can never hide the anchor they are measured against.
 */
function PlantMarkers({ plants }: { plants: (typeof t.plant.$inferSelect)[] }) {
  return (
    <>
      {plants.map((plant) => (
        <g
          key={plant.id}
          className="map-mark map-plant"
          aria-hidden="true"
          style={
            {
              '--x': `${lonToWorld(plant.lon)}px`,
              '--y': `${latToWorld(plant.lat)}px`,
            } as React.CSSProperties
          }
        >
          <rect
            x={-1}
            y={-1}
            width={2}
            height={2}
            rx={0.36}
            fill="var(--accent)"
            stroke="var(--paper)"
            strokeWidth={0.4}
          />
          <text y={3.4} textAnchor="middle" fontSize={1.7} fontWeight={650}>
            {plant.code}
          </text>
        </g>
      ))}
    </>
  );
}

function Coastlines({ paths }: { paths: string[] }) {
  return (
    <g fill="var(--map-land)" stroke="var(--map-coast)" strokeWidth={0.5} strokeLinejoin="round">
      {paths.map((d, i) => (
        <path key={i} d={d} vectorEffect="non-scaling-stroke" />
      ))}
    </g>
  );
}

/**
 * Dimming is decided on the SERVER, because a band selection is URL state.
 * The client is never told which band is chosen — it would only be able to
 * reproduce a decision already made.
 *
 * The dimmed dots stay drawn rather than being removed: the map is the
 * control you would use to change your mind, and a band you cannot see is a
 * band you cannot click your way back out of (charts.tsx's rule for the
 * bars, applied to dots).
 */
function SupplierFallbackDots({
  placed,
  filtering,
  activeBands,
  programId,
}: {
  placed: Placed[];
  filtering: boolean;
  activeBands: string[];
  programId: string;
}) {
  return (
    <g className="map-fallback">
      {placed.map(({ supplier, nearest, band }) => {
        const dimmed = filtering && (!band || !activeBands.includes(band));
        return (
          <a key={supplier.id} href={`/program/${programId}/supplier/${supplier.id}`}>
            {/*
              Position is a CSS transform, not cx/cy, so the mark can be
              counter-scaled by the camera. A radius in world units quadruples
              on screen every time you halve the viewBox — at the Europe
              camera the dots swallowed the continent.
            */}
            <circle
              className="map-mark"
              style={
                {
                  '--x': `${lonToWorld(supplier.lon)}px`,
                  '--y': `${latToWorld(supplier.lat)}px`,
                } as React.CSSProperties
              }
              r={0.62}
              fill={band ? BAND_FILL[band] : 'var(--ink-3)'}
              fillOpacity={dimmed ? 0.12 : 0.8}
              data-tip={
                nearest
                  ? `${supplier.name}|${Math.round(nearest.km).toLocaleString('en-US')} km to ${nearest.code} · ${nearest.city}`
                  : supplier.name
              }
            />
          </a>
        );
      })}
    </g>
  );
}

/**
 * Plant hit targets, drawn invisibly BELOW the Supplier marks.
 *
 * The visible Plant markers sit on top of everything so the anchor is never
 * lost behind the bidders — but on top also meant they swallowed the click:
 * Nemak is registered in Ramos Arizpe, which is exactly where P4 is, so its
 * dot was unreachable. Splitting the marker from its hit target gives both:
 * the Plant is painted last, hit-tested first, and a Supplier dot lying over
 * one wins the pointer because it is nearer the top of THIS layer.
 */
function PlantHitTargets({ plants }: { plants: (typeof t.plant.$inferSelect)[] }) {
  return (
    <g className="map-plant-hits">
      {plants.map((plant) => (
        <rect
          key={plant.id}
          className="map-mark"
          style={
            {
              '--x': `${lonToWorld(plant.lon)}px`,
              '--y': `${latToWorld(plant.lat)}px`,
            } as React.CSSProperties
          }
          x={-1}
          y={-1}
          width={2}
          height={2}
          fill="transparent"
          data-tip={`${plant.code} · ${plant.city}|${plant.role}|your plant · city centroid ±5 km`}
          data-tip-x={lonToWorld(plant.lon)}
          data-tip-y={latToWorld(plant.lat)}
        />
      ))}
    </g>
  );
}

type SupplierMapProps = {
  plants: (typeof t.plant.$inferSelect)[];
  suppliers: SupplierPoint[];
  supplierTotal: number;
  region: string | undefined;
  programId: string;
  activeBands: string[];
};

export function SupplierMap({
  plants,
  suppliers,
  supplierTotal,
  region,
  programId,
  activeBands,
}: SupplierMapProps) {
  const active = REGIONS.find((r) => r.key === region) ?? REGIONS[0];
  const paths = projectCountryPaths(world as { id: string; r: number[][] }[]);

  const plantPoints = plants.map((p) => ({ code: p.code, city: p.city, lat: p.lat, lon: p.lon }));
  const placed = placeSuppliers(suppliers, plantPoints);
  const marks = toMarks(placed);

  const unplaced = supplierTotal - suppliers.length;
  const filtering = activeBands.length > 0;

  return (
    <>
      <h3>How far from the plants</h3>
      {/*
        Keyed on the camera: picking a named region is a navigation, and a
        navigation resets any pan/zoom drift rather than leaving you framed on
        somewhere you did not ask for. A remount is the cheapest correct way to
        say that — no effect re-syncing state after the fact.
      */}
      <MapViewport
        key={active.key}
        foreground={
          <>
            <ProximityRings plants={plants} />
            <PlantMarkers plants={plants} />
          </>
        }
        initial={cameraFor(active.box)}
        worldWidth={WORLD_W}
        worldHeight={WORLD_H}
        minWidth={(MIN_CAMERA_DEG / (WORLD_BOX[2] - WORLD_BOX[0])) * WORLD_W}
        regions={REGIONS.map((r) => ({ key: r.key, label: r.label, camera: cameraFor(r.box) }))}
        activeRegion={active.key}
        bands={PROXIMITY_BANDS.map((band) => ({
          key: band,
          label: proximityBandLabel(band),
          fill: BAND_FILL[band],
        }))}
        marks={marks}
        plantPoints={plants.map((plant) => ({
          x: lonToWorld(plant.lon),
          y: latToWorld(plant.lat),
        }))}
        programId={programId}
        activeBands={activeBands}
      >
        <Coastlines paths={paths} />
        <SupplierFallbackDots
          placed={placed}
          filtering={filtering}
          activeBands={activeBands}
          programId={programId}
        />
        <PlantHitTargets plants={plants} />
      </MapViewport>

      {/*
        One line, not the paragraph it replaced. It survives because SPEC §1681
        seeds every Plant at city precision "labelled as such, because a city
        centroid is not a factory" — and because a map that draws 46 dots for a
        50-row roster and never says so lets a reader conclude the roster is
        fully mapped.
      */}
      <p className="note map-note">
        {suppliers.length} of {supplierTotal} placed
        {unplaced > 0
          ? ` · ${unplaced} without a coordinate, unknown on proximity rather than distant`
          : ''}{' '}
        · city centroids, ±5 km
      </p>
    </>
  );
}

// ── 4. Shared ownership — which "competing" bidders are the same company ─────

export function SharedOwnership({
  suppliers,
  matchBySupplier,
}: {
  suppliers: Supplier[];
  matchBySupplier: Map<string, MatchRow>;
}) {
  // Two Suppliers resolving to ONE entity is correct and is a finding, not a
  // write failure — which is why `match.entity_id` carries no unique index.
  const byEntity = new Map<string, string[]>();
  for (const supplier of suppliers) {
    const entityId = matchBySupplier.get(supplier.id)?.entityId;
    if (!entityId) continue;
    byEntity.set(entityId, [...(byEntity.get(entityId) ?? []), supplier.rosterName ?? supplier.id]);
  }
  const groups = [...byEntity.entries()].filter(([, names]) => names.length > 1);

  return (
    <section className="card">
      <h3>Which “competing” bidders are the same company</h3>
      {groups.length === 0 ? (
        <p className="note">
          No two suppliers have resolved to one company yet. This chart is kept despite having only
          a few real groups on this roster, because those groups are the finding — not the volume.
        </p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: '1.1rem', fontSize: '0.87rem' }}>
          {groups.map(([entityId, names]) => (
            <li key={entityId} style={{ marginBottom: '0.3rem' }}>
              {names.join(' + ')} <span className="badge warn">one company</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

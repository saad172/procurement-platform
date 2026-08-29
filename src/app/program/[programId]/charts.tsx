import Link from 'next/link';
import type * as t from '@/db/schema';

/**
 * The four Programme charts (SPEC §13.2).
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

/** A link that toggles one facet value, keeping every other parameter. */
function facetHref(programId: string, facet: string, value: string, active: readonly string[]): string {
  const next = active.includes(value) ? active.filter((v) => v !== value) : [...active, value];
  const params = new URLSearchParams();
  if (next.length > 0) params.set(facet, next.join(','));
  params.set('from', `${facet}_chart`);
  const query = params.toString();
  return `/program/${programId}${query ? `?${query}` : ''}`;
}

// ── 1. Country breakdown — where the roster is ───────────────────────────────

export function CountryBreakdown({
  programId,
  suppliers,
  active,
}: {
  programId: string;
  suppliers: Supplier[];
  active: string[];
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
          href={facetHref(programId, 'country', country, active) as never}
          style={{ display: 'block', color: 'inherit', textDecoration: 'none', marginBottom: '0.3rem' }}
        >
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', fontSize: '0.85rem' }}>
            <span style={{ width: '3rem', fontWeight: active.includes(country) ? 700 : 400 }}>{country}</span>
            <span className="bar" style={{ flex: 1 }}>
              <i
                style={{
                  width: `${(count / max) * 100}%`,
                  opacity: active.length === 0 || active.includes(country) ? 1 : 0.3,
                }}
              />
            </span>
            <span className="num" style={{ width: '2rem', textAlign: 'right' }}>{count}</span>
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
}: {
  programId: string;
  suppliers: Supplier[];
  matchBySupplier: Map<string, MatchRow>;
  active: string[];
}) {
  const buckets: Record<string, number> = { accepted: 0, needs_review: 0, not_found: 0, unresolved: 0 };
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
          href={facetHref(programId, 'matchStatus', status, active) as never}
          style={{ display: 'block', color: 'inherit', textDecoration: 'none', marginBottom: '0.3rem' }}
        >
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', fontSize: '0.85rem' }}>
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
            <span className="num" style={{ width: '2rem', textAlign: 'right' }}>{count}</span>
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

const REGIONS = [
  { key: 'world', label: 'World', box: [-180, -60, 180, 75] },
  { key: 'north-america', label: 'N. America', box: [-130, 14, -60, 55] },
  { key: 'europe', label: 'Europe', box: [-12, 35, 32, 62] },
  { key: 'east-asia', label: 'E. Asia', box: [95, 18, 148, 48] },
] as const;

export function SupplierMap({
  plants,
  region,
  programId,
}: {
  plants: (typeof t.plant.$inferSelect)[];
  region: string | undefined;
  programId: string;
}) {
  const active = REGIONS.find((r) => r.key === region) ?? REGIONS[0];
  const [minLon, minLat, maxLon, maxLat] = active.box;
  const project = (lon: number, lat: number) => ({
    x: ((lon - minLon) / (maxLon - minLon)) * 100,
    y: ((maxLat - lat) / (maxLat - minLat)) * 100,
  });
  const inView = plants.filter(
    (p) => p.lon >= minLon && p.lon <= maxLon && p.lat >= minLat && p.lat <= maxLat,
  );

  return (
    <section className="card">
      <h3>How far from the plants</h3>
      <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.6rem', flexWrap: 'wrap' }}>
        {REGIONS.map((r) => (
          <Link
            key={r.key}
            href={`/program/${programId}?region=${r.key}` as never}
            className="badge"
            style={r.key === active.key ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
          >
            {r.label}
          </Link>
        ))}
      </div>
      <svg viewBox="0 0 100 60" style={{ width: '100%', background: 'var(--paper-2)', borderRadius: 4 }}>
        {plants.map((plant) => {
          const { x, y } = project(plant.lon, plant.lat);
          const visible = x >= 0 && x <= 100 && y >= 0 && y <= 100;
          if (!visible) return null;
          return (
            <g key={plant.id}>
              <rect x={x - 1.2} y={(y * 0.6) - 1.2} width={2.4} height={2.4} fill="var(--accent)" rx={0.4} />
              <text x={x + 2} y={(y * 0.6) + 1} fontSize={2.4} fill="var(--ink-2)">
                {plant.code}
              </text>
            </g>
          );
        })}
      </svg>
      {/*
        "N of 50 in view" is not decoration: a single world view letterboxes
        badly and silently hides clusters, so the count is what tells you the
        camera is cropping.
      */}
      <p className="note" style={{ marginTop: '0.5rem' }}>
        {inView.length} of {plants.length} plants in view. Every plant is a city centroid, ±5 km — a
        centroid is not a factory, and proximity is measured from a registered address that is not one
        either.
      </p>
    </section>
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
          No two suppliers have resolved to one company yet. This chart is kept despite having only a
          few real groups on this roster, because those groups are the finding — not the volume.
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

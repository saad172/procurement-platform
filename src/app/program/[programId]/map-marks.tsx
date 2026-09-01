'use client';

import { useMemo, useState } from 'react';

/**
 * The Supplier marks: clustering, the donut, the spider, and the hover.
 *
 * **Marks are data; geometry is not.** The 46 points below cross to the browser
 * as ~4 KB of JSON because clustering has to happen in screen space, and screen
 * space only exists here. The 104 KB of coastline stays on the server and
 * arrives as rendered paths — it never needed to be re-projected, and it still
 * doesn't.
 *
 * The server also renders a plain, unclustered set of these same dots. That set
 * is hidden the moment this component mounts (see `.map-shell.js`), so a reader
 * without JavaScript still gets every supplier on the map, just without the
 * clustering.
 *
 * `MapMarks` itself is one derived value (`clusters`) fed into one loop; the
 * per-cluster decision — a single `Dot`, a fanned-out `SpiderCluster`, or a
 * `ClusterRing` — is drawn by the named `ClusterMark` below it, so "how is a
 * cluster of 14 drawn" has one place to look.
 */

export type Mark = {
  id: string;
  name: string;
  /** World units, projected server-side. */
  x: number;
  y: number;
  band: 'near' | 'mid' | 'far' | null;
  km: number | null;
  plant: string | null;
  country: string;
  status: string;
  assessed: boolean;
};

const BAND_FILL: Record<string, string> = {
  near: 'var(--good)',
  mid: 'var(--warn)',
  far: 'var(--bad)',
};

/** Base radius in screen-constant units, before the camera counter-scale. */
const DOT_R = 0.62;

/**
 * How close is "the same place", as a fraction of the camera width.
 *
 * Expressed against the camera rather than the world so it means the same thing
 * at every zoom: two dots merge when they are within about 2.4% of what you can
 * currently see, which is roughly two dot-widths apart on screen.
 */
const CLUSTER_FRACTION = 0.024;

export type Cluster = {
  key: string;
  x: number;
  y: number;
  members: Mark[];
};

/**
 * Greedy single-pass clustering in camera space.
 *
 * Greedy rather than k-means because the result must be **stable under
 * panning**: a cluster that reshuffles its membership as you drag reads as the
 * map lying to you. Sorting by position first makes the sweep deterministic.
 */
export function clusterRadius(count: number, dotR: number): number {
  // Area carries the number, so a cluster of 16 is not drawn four times as wide
  // as a cluster of 4.
  return dotR * (1.5 + Math.sqrt(count) * 0.42);
}

export function clusterMarks(marks: Mark[], threshold: number, dotR: number): Cluster[] {
  const sorted = [...marks].sort((a, b) => a.x - b.x || a.y - b.y);
  const taken = new Set<string>();
  const out: Cluster[] = [];

  for (const mark of sorted) {
    if (taken.has(mark.id)) continue;
    taken.add(mark.id);
    const members = [mark];

    for (const other of sorted) {
      if (taken.has(other.id)) continue;
      if (Math.hypot(other.x - mark.x, other.y - mark.y) > threshold) continue;
      taken.add(other.id);
      members.push(other);
    }

    // Anchored on the members' centroid, not the seed, so the mark sits in the
    // middle of what it stands for.
    const x = members.reduce((sum, m) => sum + m.x, 0) / members.length;
    const y = members.reduce((sum, m) => sum + m.y, 0) / members.length;
    out.push({ key: mark.id, x, y, members });
  }

  /**
   * Second pass: merge clusters that would be drawn on top of each other.
   *
   * The first pass groups by distance, but a cluster's radius grows with its
   * count — so a 14 and a 4 can sit further apart than the grouping threshold
   * and still collide on screen. Two overlapping rings read as one unreadable
   * mark with two numbers in it, which is worse than a single honest 18.
   */
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < out.length; i += 1) {
      for (let j = i + 1; j < out.length; j += 1) {
        const a = out[i]!;
        const b = out[j]!;
        const reach =
          (clusterRadius(a.members.length, dotR) + clusterRadius(b.members.length, dotR)) * 0.9;
        if (Math.hypot(a.x - b.x, a.y - b.y) > reach) continue;
        const members = [...a.members, ...b.members];
        out[i] = {
          key: a.key,
          x: members.reduce((sum, m) => sum + m.x, 0) / members.length,
          y: members.reduce((sum, m) => sum + m.y, 0) / members.length,
          members,
        };
        out.splice(j, 1);
        merged = true;
        break outer;
      }
    }
  }

  return out;
}

/** One arc of the donut, stroked rather than filled so the count stays legible. */
function arcPath(cx: number, cy: number, r: number, from: number, to: number): string {
  // A full ring cannot be drawn as a single arc — its start and end points are
  // the same, and the renderer draws nothing at all.
  if (to - from >= Math.PI * 2 - 1e-6) {
    return `M${cx - r} ${cy}A${r} ${r} 0 1 1 ${cx + r} ${cy}A${r} ${r} 0 1 1 ${cx - r} ${cy}`;
  }
  const x0 = cx + r * Math.cos(from);
  const y0 = cy + r * Math.sin(from);
  const x1 = cx + r * Math.cos(to);
  const y1 = cy + r * Math.sin(to);
  return `M${x0} ${y0}A${r} ${r} 0 ${to - from > Math.PI ? 1 : 0} 1 ${x1} ${y1}`;
}

/**
 * Where the count goes.
 *
 * Suppliers cluster where the Plants are — that is the finding, not a
 * coincidence — so any fixed offset eventually puts the number underneath a
 * Plant marker, and the Plant wins that overlap because it is the anchor
 * every distance is measured from. Neighbouring clusters are obstacles for
 * the same reason: a count sitting inside the next ring along reads as that
 * ring's number.
 *
 * So the label walks a ring of candidate positions and takes the first clear
 * of everything else drawn. This is hand label-placement, and it is the only
 * mark on the map that needs it — because it is the only one whose position
 * carries no meaning of its own.
 *
 * Pure: `r` is the counter-scaled dot radius, passed in rather than closed
 * over, so this has no dependency on any component's render.
 */
function findLabelSpot(
  cx: number,
  cy: number,
  cr: number,
  r: number,
  obstacles: { x: number; y: number; r: number }[],
): { x: number; y: number } {
  const reach = cr + r * 0.75;
  const angles = [-90, -45, -135, 0, 180, 45, 135, 90];
  for (const degrees of angles) {
    const radians = (degrees * Math.PI) / 180;
    const x = cx + reach * Math.cos(radians);
    const y = cy + reach * Math.sin(radians);
    const clear = obstacles.every((o) => Math.hypot(o.x - x, o.y - y) > o.r + r * 0.9);
    if (clear) return { x, y: y + r * 0.35 };
  }
  return { x: cx, y: cy - reach };
}

/**
 * One supplier.
 *
 * Defined at module scope, **not inside the parent's render**. As a nested
 * arrow it was a new component type on every camera change, so React unmounted
 * and remounted all 46 dots on every frame of a drag — which threw away the
 * hover state and the CSS transition mid-gesture and made the lift look dead
 * even when it fired.
 *
 * It stays an anchor so ⌘-click and middle-click still open a supplier in a new
 * tab and the keyboard can reach it; a plain left click is intercepted and
 * turned into a selection instead of a navigation.
 */
function Dot({
  mark,
  cx,
  cy,
  r,
  dimmed,
  selected,
  programId,
  onSelect,
}: {
  mark: Mark;
  cx: number;
  cy: number;
  r: number;
  dimmed: boolean;
  selected: boolean;
  programId: string;
  onSelect: (mark: Mark) => void;
}) {
  return (
    <a
      href={`/program/${programId}/supplier/${mark.id}`}
      className="map-dot-hit"
      aria-label={mark.name}
      data-tip={
        mark.km != null && mark.plant
          ? `${mark.name}|${mark.km.toLocaleString('en-US')} km to ${mark.plant}|click for detail`
          : `${mark.name}|click for detail`
      }
      data-tip-x={cx}
      data-tip-y={cy - r}
      onClick={(event) => {
        // A modified click is a real navigation; a plain one opens the card.
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        onSelect(mark);
      }}
    >
      {selected ? (
        <circle className="map-dot-halo" cx={cx} cy={cy} r={r * 2.1} />
      ) : null}
      <circle
        className="map-dot"
        cx={cx}
        cy={cy}
        r={r}
        fill={mark.band ? BAND_FILL[mark.band] : 'var(--ink-3)'}
        fillOpacity={dimmed ? 0.12 : 0.85}
        stroke="var(--paper)"
        strokeWidth={r * 0.32}
        strokeOpacity={dimmed ? 0.12 : 0.9}
        style={{ transformOrigin: `${cx}px ${cy}px` }}
      />
    </a>
  );
}

/**
 * Fanned onto a ring, each on a leader line back to the true point. The line
 * is the honesty: drawn here, actually there.
 */
function SpiderCluster({
  cluster,
  cr,
  r,
  dim,
  selectedId,
  programId,
  onSelect,
  onClose,
}: {
  cluster: Cluster;
  cr: number;
  r: number;
  dim: (band: string | null) => boolean;
  selectedId: string | null;
  programId: string;
  onSelect: (mark: Mark | null) => void;
  onClose: () => void;
}) {
  const spread = cr * 2.4;
  return (
    <g className="map-spider">
      {cluster.members.map((mark, i) => {
        const angle = (i / cluster.members.length) * Math.PI * 2 - Math.PI / 2;
        const sx = cluster.x + spread * Math.cos(angle);
        const sy = cluster.y + spread * Math.sin(angle);
        return (
          <g key={mark.id}>
            <line
              x1={cluster.x}
              y1={cluster.y}
              x2={sx}
              y2={sy}
              stroke="var(--ink-3)"
              strokeWidth={r * 0.18}
              strokeOpacity={0.5}
            />
            <Dot
              mark={mark}
              cx={sx}
              cy={sy}
              r={r}
              dimmed={dim(mark.band)}
              selected={selectedId === mark.id}
              programId={programId}
              onSelect={onSelect}
            />
          </g>
        );
      })}
      <circle cx={cluster.x} cy={cluster.y} r={r * 0.3} fill="var(--ink-3)" onClick={onClose} />
    </g>
  );
}

/** The donut ring: band proportions as arcs, and the member count placed clear of every neighbour. */
function ClusterRing({
  cluster,
  clusters,
  plants,
  scale,
  r,
  cr,
  filtering,
  activeBands,
  atZoomCap,
  onSelect,
  onZoomToFit,
  onSpiderfy,
}: {
  cluster: Cluster;
  clusters: Cluster[];
  plants: { x: number; y: number }[];
  scale: number;
  r: number;
  cr: number;
  filtering: boolean;
  activeBands: string[];
  atZoomCap: boolean;
  onSelect: (mark: Mark | null) => void;
  onZoomToFit: (cluster: Cluster) => void;
  onSpiderfy: (key: string) => void;
}) {
  // The ring is divided by band, in member proportion. A cluster that
  // averaged its members away would hide a supplier on the far side of
  // the world inside a green dot.
  const counts = new Map<string, number>();
  for (const mark of cluster.members) {
    const key = mark.band ?? 'unknown';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let angle = -Math.PI / 2;
  const arcs = [...counts.entries()].map(([band, count]) => {
    const from = angle;
    angle += (count / cluster.members.length) * Math.PI * 2;
    return { band, from, to: angle, count };
  });

  const dimmedCluster =
    filtering && !cluster.members.some((m) => m.band && activeBands.includes(m.band));

  const spot = findLabelSpot(cluster.x, cluster.y, cr, r, [
    ...plants.map((plant) => ({ ...plant, r: scale })),
    ...clusters
      .filter((other) => other.key !== cluster.key && other.members.length > 1)
      .map((other) => ({ x: other.x, y: other.y, r: clusterRadius(other.members.length, r) })),
  ]);

  return (
    <g
      className="map-cluster"
      opacity={dimmedCluster ? 0.22 : 1}
      data-tip={[
        `${cluster.members.length} suppliers`,
        ...cluster.members.slice(0, 5).map((m) => m.name),
        ...(cluster.members.length > 5 ? [`and ${cluster.members.length - 5} more`] : []),
        atZoomCap ? 'click to fan them out' : 'click to zoom in',
      ].join('|')}
      data-tip-x={cluster.x}
      data-tip-y={cluster.y - cr}
      onClick={() => {
        onSelect(null);
        if (atZoomCap) onSpiderfy(cluster.key);
        else onZoomToFit(cluster);
      }}
    >
      <circle cx={cluster.x} cy={cluster.y} r={cr} fill="var(--paper)" fillOpacity={0.94} />
      {arcs.map((arc) => (
        <path
          key={arc.band}
          d={arcPath(cluster.x, cluster.y, cr, arc.from, arc.to)}
          fill="none"
          stroke={BAND_FILL[arc.band] ?? 'var(--ink-3)'}
          strokeWidth={cr * 0.34}
          strokeOpacity={0.9}
        />
      ))}
      {/*
        The count rides ABOVE the ring, not inside it.

        Suppliers cluster where the Plants are — that is the whole point of
        the picture — so a number in the middle of the ring sits exactly
        where a Plant marker lands and disappears under it. The Plant wins
        that overlap (it is the anchor every distance is measured from), so
        the number moves to where nothing else is ever drawn.
      */}
      <text
        className="map-cluster-count"
        x={spot.x}
        y={spot.y}
        textAnchor="middle"
        fontSize={cr * 0.85}
        fontWeight={700}
        stroke="var(--map-water)"
        strokeWidth={cr * 0.3}
      >
        {cluster.members.length}
      </text>
    </g>
  );
}

/**
 * One cluster: a single member draws as a `Dot`; several draw as a `ClusterRing`
 * until clicked open, at which point they fan out as a `SpiderCluster`.
 */
function ClusterMark({
  cluster,
  clusters,
  plants,
  scale,
  r,
  dim,
  filtering,
  activeBands,
  selectedId,
  programId,
  onSelect,
  atZoomCap,
  onZoomToFit,
  spiderfied,
  onSpiderfy,
}: {
  cluster: Cluster;
  clusters: Cluster[];
  plants: { x: number; y: number }[];
  scale: number;
  r: number;
  dim: (band: string | null) => boolean;
  filtering: boolean;
  activeBands: string[];
  selectedId: string | null;
  programId: string;
  onSelect: (mark: Mark | null) => void;
  atZoomCap: boolean;
  onZoomToFit: (cluster: Cluster) => void;
  spiderfied: string | null;
  onSpiderfy: (key: string | null) => void;
}) {
  const single = cluster.members[0];
  if (cluster.members.length === 1 && single) {
    return (
      <Dot
        mark={single}
        cx={cluster.x}
        cy={cluster.y}
        r={r}
        dimmed={dim(single.band)}
        selected={selectedId === single.id}
        programId={programId}
        onSelect={onSelect}
      />
    );
  }

  const cr = clusterRadius(cluster.members.length, r);
  if (spiderfied === cluster.key) {
    return (
      <SpiderCluster
        cluster={cluster}
        cr={cr}
        r={r}
        dim={dim}
        selectedId={selectedId}
        programId={programId}
        onSelect={onSelect}
        onClose={() => onSpiderfy(null)}
      />
    );
  }

  return (
    <ClusterRing
      cluster={cluster}
      clusters={clusters}
      plants={plants}
      scale={scale}
      r={r}
      cr={cr}
      filtering={filtering}
      activeBands={activeBands}
      atZoomCap={atZoomCap}
      onSelect={onSelect}
      onZoomToFit={onZoomToFit}
      onSpiderfy={onSpiderfy}
    />
  );
}

type MapMarksProps = {
  marks: Mark[];
  /** Plant positions in world units, so a count can dodge them. */
  plants: { x: number; y: number }[];
  programId: string;
  activeBands: string[];
  cameraWidth: number;
  /** Camera scale, so a mark holds its screen size at every zoom. */
  scale: number;
  atZoomCap: boolean;
  onZoomToFit: (cluster: Cluster) => void;
  selectedId: string | null;
  onSelect: (mark: Mark | null) => void;
};

export function MapMarks({
  marks,
  plants,
  programId,
  activeBands,
  cameraWidth,
  scale,
  atZoomCap,
  onZoomToFit,
  selectedId,
  onSelect,
}: MapMarksProps) {
  const [spiderfied, setSpiderfied] = useState<string | null>(null);

  const clusters = useMemo(
    () => clusterMarks(marks, cameraWidth * CLUSTER_FRACTION, DOT_R * scale),
    [marks, cameraWidth, scale],
  );

  const filtering = activeBands.length > 0;
  const dim = (band: string | null) => filtering && (!band || !activeBands.includes(band));
  const r = DOT_R * scale;

  return (
    <g className="map-marks">
      {clusters.map((cluster) => (
        <ClusterMark
          key={cluster.key}
          cluster={cluster}
          clusters={clusters}
          plants={plants}
          scale={scale}
          r={r}
          dim={dim}
          filtering={filtering}
          activeBands={activeBands}
          selectedId={selectedId}
          programId={programId}
          onSelect={onSelect}
          atZoomCap={atZoomCap}
          onZoomToFit={onZoomToFit}
          spiderfied={spiderfied}
          onSpiderfy={setSpiderfied}
        />
      ))}
    </g>
  );
}

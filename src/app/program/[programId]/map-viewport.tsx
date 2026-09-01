'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { MapMarks, type Cluster, type Mark } from './map-marks';

/**
 * The interactive shell around the Plant map.
 *
 * **It owns the camera and nothing else.** Every mark inside it — coastlines,
 * supplier dots, Plant markers, the dimming a band selection causes — is
 * rendered on the server and arrives here as `children`. That is deliberate
 * three times over:
 *
 * - The 104 KB basemap never reaches the browser. Projection happens once, on
 *   the server, into a fixed world coordinate space; this component only moves
 *   a `viewBox` over it.
 * - Passing the marks as `children` rather than as props keeps them out of the
 *   client payload as *data*. Props would serialise every path twice — once as
 *   HTML, once as flight.
 * - With JavaScript off the server-rendered `viewBox` still frames the named
 *   camera correctly. Pan and zoom are an enhancement on a map that already
 *   works, not the thing that makes it work.
 *
 * **Plain scroll is never intercepted.** The map is full-width and sits above
 * the roster, so a wheel that zooms instead of scrolling would trap the page.
 * Zoom is the buttons, a double-click, or ⌘/Ctrl + wheel — the pattern embedded
 * maps settled on after exactly this complaint.
 *
 * The body below reads state → derived geometry → JSX: each concern (camera,
 * drag, wheel-zoom, the tooltip, the region/band URL sync) is a named hook
 * above, and each drawn overlay (the camera badges, the legend, the zoom
 * buttons, the tooltip, the selected card) is a named sub-component below —
 * so "where is zoom handled" or "where is the card drawn" both land in one
 * place in this file.
 */

export type Camera = { x: number; y: number; w: number; h: number };

export type RegionChoice = { key: string; label: string; camera: Camera };
export type BandChoice = { key: string; label: string; fill: string };

/** The mounted flag never changes after hydration, so nothing to subscribe to. */
const subscribeNever = () => () => {};

/**
 * False on the server, true once the client has taken over. While false the
 * server's plain, unclustered dots are the ones on screen — so a reader with
 * JavaScript off keeps every supplier, and nobody sees an empty map for a
 * frame.
 *
 * `useSyncExternalStore` rather than an effect that sets state: it gives the
 * server and the client different snapshots by design, which is exactly the
 * question being asked, and it does not schedule a second render pass.
 */
function useMountedOnClient() {
  return useSyncExternalStore(subscribeNever, () => true, () => false);
}

type MapViewportProps = {
  /** The named camera the server chose from `?region`, in world units. */
  initial: Camera;
  worldWidth: number;
  worldHeight: number;
  /**
   * The tightest the camera may go, in world units.
   *
   * A **precision** limit, not a rendering one: every dot is a city centroid
   * ±5 km, and past this width a dot draws smaller than its own error bar and
   * starts pointing at a street corner for a company whose coordinate is a
   * city. The same argument `geo.ts` makes for refusing to route distances
   * along roads — more precise-looking, which is worse.
   */
  minWidth: number;
  /** Supplier marks, clustered in the browser where screen space exists. */
  marks: Mark[];
  plantPoints: { x: number; y: number }[];
  programId: string;
  activeBands: string[];
  regions: RegionChoice[];
  activeRegion: string;
  bands: BandChoice[];
  children: React.ReactNode;
  /**
   * Drawn after the Supplier marks. The Plants live here because they are the
   * four fixed points every distance is measured FROM — losing one under a
   * cluster of the bidders being measured hides the anchor behind the answer.
   */
  foreground?: React.ReactNode;
  /**
   * Chrome drawn over the map — cameras and the band key. Server-rendered and
   * passed through, for the same reason `children` is: these are links, and a
   * link does not need JavaScript to work.
   */
  overlay?: React.ReactNode;
};

// ── State: the camera ────────────────────────────────────────────────────────

/**
 * The camera: current viewport, and the maths that moves it. Everything else
 * in this file — drag, wheel-zoom, the region presets — ends by calling
 * `setCamera` or `clamp`; this hook is where those primitives live.
 */
function useMapCamera({
  initial,
  worldWidth,
  worldHeight,
  minWidth,
  svgRef,
}: {
  initial: Camera;
  worldWidth: number;
  worldHeight: number;
  minWidth: number;
  svgRef: React.RefObject<SVGSVGElement | null>;
}) {
  const [camera, setCamera] = useState<Camera>(initial);

  /** Clamped so the world can never be panned off its own edges. */
  const clamp = useCallback(
    (next: Camera): Camera => {
      const w = Math.min(Math.max(next.w, minWidth), worldWidth);
      const h = w * (worldHeight / worldWidth);
      return {
        w,
        h,
        x: Math.min(Math.max(next.x, 0), worldWidth - w),
        y: Math.min(Math.max(next.y, 0), worldHeight - h),
      };
    },
    [minWidth, worldWidth, worldHeight],
  );

  /** Zoom about a fixed point, so the spot under the cursor stays under it. */
  const zoomAbout = useCallback(
    (factor: number, originX: number, originY: number) => {
      setCamera((current) => {
        const w = current.w * factor;
        const next = clamp({ ...current, w, h: w * (worldHeight / worldWidth) });
        const scale = next.w / current.w;
        return clamp({
          ...next,
          x: originX - (originX - current.x) * scale,
          y: originY - (originY - current.y) * scale,
        });
      });
    },
    [clamp, worldHeight, worldWidth],
  );

  /** Client pixels → world units, for zooming about the cursor. */
  const toWorld = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      const svg = svgRef.current;
      if (!svg) return null;
      const rect = svg.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      return {
        x: camera.x + ((clientX - rect.left) / rect.width) * camera.w,
        y: camera.y + ((clientY - rect.top) / rect.height) * camera.h,
      };
    },
    [camera, svgRef],
  );

  /** Frame a cluster's members, with room around them. */
  const zoomToFit = useCallback(
    (cluster: Cluster) => {
      const xs = cluster.members.map((m) => m.x);
      const ys = cluster.members.map((m) => m.y);
      const spanX = Math.max(...xs) - Math.min(...xs);
      const spanY = Math.max(...ys) - Math.min(...ys);
      const w = Math.max(spanX, spanY * (worldWidth / worldHeight)) * 3 + minWidth;
      setCamera(
        clamp({
          w,
          h: w * (worldHeight / worldWidth),
          x: cluster.x - w / 2,
          y: cluster.y - (w * (worldHeight / worldWidth)) / 2,
        }),
      );
    },
    [clamp, minWidth, worldHeight, worldWidth],
  );

  /**
   * World units → a percentage of the shell.
   *
   * Overlays used to be placed from `getBoundingClientRect`, which is a
   * measurement taken once and wrong immediately: the card stayed put while the
   * map moved under it. A percentage of the camera is exact at every frame of a
   * drag and needs no measuring at all.
   */
  const toPercent = (x: number, y: number) => ({
    left: `${((x - camera.x) / camera.w) * 100}%`,
    top: `${((y - camera.y) / camera.h) * 100}%`,
  });

  const zoomedIn = camera.w < worldWidth;

  return { camera, setCamera, clamp, zoomAbout, toWorld, zoomToFit, toPercent, zoomedIn };
}

// ── State: panning ────────────────────────────────────────────────────────────

/** Pointer-drag panning. Starting a drag also clears any selection. */
function usePanDrag({
  svgRef,
  camera,
  clamp,
  setCamera,
  onDragStart,
}: {
  svgRef: React.RefObject<SVGSVGElement | null>;
  camera: Camera;
  clamp: (next: Camera) => Camera;
  setCamera: React.Dispatch<React.SetStateAction<Camera>>;
  onDragStart: () => void;
}) {
  const dragRef = useRef<{ pointerId: number; x: number; y: number; camera: Camera } | null>(null);

  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    /*
     * Only empty map starts a drag.
     *
     * This is not just about convenience: `setPointerCapture` below retargets
     * the subsequent `click` to the <svg>, so a drag begun on a mark eats that
     * mark's own click. A cluster looked completely inert because of it — the
     * zoom-to-fit handler was never reached.
     */
    if ((event.target as Element).closest('a, .map-cluster, .map-spider')) return;
    onDragStart();
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, camera };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    const svg = svgRef.current;
    if (!drag || !svg || drag.pointerId !== event.pointerId) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0) return;
    const perPixel = drag.camera.w / rect.width;
    setCamera(
      clamp({
        ...drag.camera,
        x: drag.camera.x - (event.clientX - drag.x) * perPixel,
        y: drag.camera.y - (event.clientY - drag.y) * perPixel,
      }),
    );
  };

  const endDrag = (event: React.PointerEvent<SVGSVGElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return { onPointerDown, onPointerMove, endDrag };
}

/**
 * Wheel-zoom only with the platform modifier held. React's onWheel is
 * passive, so `preventDefault` there is a no-op and the page would scroll as
 * well as the map zooming — hence a native non-passive listener.
 */
function useWheelZoom(
  svgRef: React.RefObject<SVGSVGElement | null>,
  toWorld: (clientX: number, clientY: number) => { x: number; y: number } | null,
  zoomAbout: (factor: number, originX: number, originY: number) => void,
) {
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.metaKey && !event.ctrlKey) return;
      event.preventDefault();
      const origin = toWorld(event.clientX, event.clientY);
      if (!origin) return;
      zoomAbout(event.deltaY > 0 ? 1.15 : 1 / 1.15, origin.x, origin.y);
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [toWorld, zoomAbout, svgRef]);
}

// ── State: selection ──────────────────────────────────────────────────────────

/** Escape closes the selected card, same as its own close button. */
function useEscapeToDeselect(selected: Mark | null, setSelected: (mark: Mark | null) => void) {
  useEffect(() => {
    if (!selected) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelected(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, setSelected]);
}

// ── State: the tooltip ────────────────────────────────────────────────────────

/**
 * One delegated listener, reading `data-*` off whichever mark is under the
 * cursor. Per-dot handlers would mean 46 closures and 46 props; the marks
 * carry their own text instead, written server-side.
 */
function useMapTooltip() {
  const [tip, setTip] = useState<{ x: number; y: number; lines: string[] } | null>(null);

  const onMouseOver = (event: React.MouseEvent<SVGSVGElement>) => {
    const mark = (event.target as Element).closest('[data-tip]');
    if (!mark) return setTip(null);
    const lines = (mark.getAttribute('data-tip') ?? '').split('|').filter(Boolean);
    if (lines.length === 0) return setTip(null);

    /*
     * The mark states its own anchor, in world units.
     *
     * This used to read `getBBox()`, which returns coordinates BEFORE any
     * transform — and the Plant hit targets are positioned by a CSS transform,
     * so every Plant reported [-1,-1,2,2] and its tooltip was placed off the
     * top-left corner of the map. Hovering P1 or P2 looked like nothing
     * happening at all. An explicit attribute cannot drift from the mark.
     */
    const x = Number(mark.getAttribute('data-tip-x'));
    const y = Number(mark.getAttribute('data-tip-y'));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return setTip(null);
    setTip({ x, y, lines });
  };

  return { tip, setTip, onMouseOver };
}

// ── State: the region/band URL sync ──────────────────────────────────────────

/**
 * A camera preset moves the viewport and nothing else, so it must not cost a
 * server round trip.
 *
 * These were `<Link>`s, which is a real navigation: every tab click refetched
 * the RSC payload and re-rendered the entire page — the stat strip, both
 * tables, all fifty roster rows — to move a viewport the browser could move
 * itself. The URL still changes, so the view stays shareable and survives a
 * reload; it just changes with `pushState` instead of a fetch.
 */
function useCameraUrl({
  regions,
  activeRegion,
  clamp,
  setCamera,
}: {
  regions: RegionChoice[];
  activeRegion: string;
  clamp: (next: Camera) => Camera;
  setCamera: React.Dispatch<React.SetStateAction<Camera>>;
}) {
  const [region, setRegion] = useState(activeRegion);

  const chooseRegion = useCallback(
    (choice: RegionChoice) => {
      setRegion(choice.key);
      setCamera(clamp(choice.camera));
      const params = new URLSearchParams(window.location.search);
      if (choice.key === 'world') params.delete('region');
      else params.set('region', choice.key);
      const query = params.toString();
      window.history.pushState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
    },
    [clamp, setCamera],
  );

  /** Back and forward have to move the camera too, or the URL starts lying. */
  useEffect(() => {
    const onPop = () => {
      const key = new URLSearchParams(window.location.search).get('region') ?? 'world';
      const choice = regions.find((r) => r.key === key) ?? regions[0];
      if (!choice) return;
      setRegion(choice.key);
      setCamera(clamp(choice.camera));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [regions, clamp, setCamera]);

  return { region, chooseRegion };
}

/**
 * A band IS a facet — it changes which Suppliers are being talked about, so
 * the server has to re-render and this one really is a navigation. It is
 * built from the LIVE url rather than a baked href so that a camera chosen
 * since the page rendered is carried along instead of silently reverted.
 */
function useBandFilter(router: ReturnType<typeof useRouter>) {
  return useCallback(
    (key: string) => {
      const params = new URLSearchParams(window.location.search);
      const current = (params.get('proximityBand') ?? '').split(',').filter(Boolean);
      const next = current.includes(key) ? current.filter((b) => b !== key) : [...current, key];
      if (next.length > 0) params.set('proximityBand', next.join(','));
      else params.delete('proximityBand');
      params.set('from', 'proximityBand_chart');
      const query = params.toString();
      router.push(`${window.location.pathname}${query ? `?${query}` : ''}` as never);
    },
    [router],
  );
}

// ── Drawing: chrome over the map ──────────────────────────────────────────────

function MapCameraBadges({
  regions,
  region,
  onChoose,
}: {
  regions: RegionChoice[];
  region: string;
  onChoose: (choice: RegionChoice) => void;
}) {
  return (
    <div className="map-cameras">
      {regions.map((choice) => (
        <a
          key={choice.key}
          href={`?region=${choice.key}`}
          className="badge"
          style={choice.key === region ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
            event.preventDefault();
            onChoose(choice);
          }}
        >
          {choice.label}
        </a>
      ))}
    </div>
  );
}

function MapLegend({
  bands,
  activeBands,
  onToggle,
}: {
  bands: BandChoice[];
  activeBands: string[];
  onToggle: (key: string) => void;
}) {
  return (
    <div className="map-legend">
      <span className="map-key">
        <svg width="9" height="9" aria-hidden="true">
          <rect width="9" height="9" rx="1.5" fill="var(--accent)" />
        </svg>{' '}
        plant
      </span>
      {bands.map((band) => {
        const on = activeBands.includes(band.key);
        return (
          <a
            key={band.key}
            href={`?proximityBand=${band.key}`}
            className="map-key"
            style={{ opacity: activeBands.length > 0 && !on ? 0.45 : 1, fontWeight: on ? 600 : 400 }}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
              event.preventDefault();
              onToggle(band.key);
            }}
          >
            <svg width="9" height="9" aria-hidden="true">
              <circle cx="4.5" cy="4.5" r="3.6" fill={band.fill} fillOpacity={0.8} />
            </svg>{' '}
            {band.label}
          </a>
        );
      })}
    </div>
  );
}

function MapZoomControls({
  zoomedIn,
  atMinWidth,
  onZoomOut,
  onZoomIn,
}: {
  zoomedIn: boolean;
  atMinWidth: boolean;
  onZoomOut: () => void;
  onZoomIn: () => void;
}) {
  return (
    <div className="map-zoom">
      <button type="button" aria-label="Zoom out" disabled={!zoomedIn} onClick={onZoomOut}>
        −
      </button>
      <button type="button" aria-label="Zoom in" disabled={atMinWidth} onClick={onZoomIn}>
        +
      </button>
    </div>
  );
}

/** The SVG canvas: the coastline/mark children, the clustered marks, and the pointer plumbing that drives them. */
function MapCanvas({
  svgRef,
  camera,
  worldWidth,
  minWidth,
  mounted,
  marks,
  plantPoints,
  programId,
  activeBands,
  selectedId,
  onSelect,
  onZoomToFit,
  onPointerDown,
  onPointerMove,
  endDrag,
  onMouseOver,
  onMouseOut,
  onDoubleClick,
  children,
  foreground,
}: {
  svgRef: React.RefObject<SVGSVGElement | null>;
  camera: Camera;
  worldWidth: number;
  minWidth: number;
  mounted: boolean;
  marks: Mark[];
  plantPoints: { x: number; y: number }[];
  programId: string;
  activeBands: string[];
  selectedId: string | null;
  onSelect: (mark: Mark | null) => void;
  onZoomToFit: (cluster: Cluster) => void;
  onPointerDown: (event: React.PointerEvent<SVGSVGElement>) => void;
  onPointerMove: (event: React.PointerEvent<SVGSVGElement>) => void;
  endDrag: (event: React.PointerEvent<SVGSVGElement>) => void;
  onMouseOver: (event: React.MouseEvent<SVGSVGElement>) => void;
  onMouseOut: (event: React.MouseEvent<SVGSVGElement>) => void;
  onDoubleClick: (event: React.MouseEvent<SVGSVGElement>) => void;
  children: React.ReactNode;
  foreground?: React.ReactNode;
}) {
  return (
    <svg
      ref={svgRef}
      viewBox={`${camera.x.toFixed(3)} ${camera.y.toFixed(3)} ${camera.w.toFixed(3)} ${camera.h.toFixed(3)}`}
      className="map-svg"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onMouseOver={onMouseOver}
      onMouseOut={onMouseOut}
      onDoubleClick={onDoubleClick}
    >
      {children}
      {mounted ? (
        <MapMarks
          marks={marks}
          plants={plantPoints}
          programId={programId}
          activeBands={activeBands}
          cameraWidth={camera.w}
          scale={camera.w / worldWidth}
          atZoomCap={camera.w <= minWidth * 1.02}
          onZoomToFit={onZoomToFit}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      ) : null}
      {foreground}
    </svg>
  );
}

function MapTooltipCard({
  tip,
  toPercent,
}: {
  tip: { x: number; y: number; lines: string[] };
  toPercent: (x: number, y: number) => { left: string; top: string };
}) {
  return (
    <div className="map-tip" style={toPercent(tip.x, tip.y)} role="status">
      {tip.lines.map((line, i) => (
        <span key={line} className={i === 0 ? 'tip-name' : undefined}>
          {line}
        </span>
      ))}
    </div>
  );
}

/**
 * The card, not a navigation.
 *
 * A dot used to be a bare anchor, so a plain click left the page entirely —
 * and because a click can end a drag, panning the map could throw you onto
 * a supplier you never meant to open. Selecting in place is both the safer
 * gesture and the more useful one: the answer to "what is this dot" is four
 * fields, and you are usually asking about several dots in a row.
 */
function MapSelectedCard({
  selected,
  programId,
  toPercent,
  onClose,
}: {
  selected: Mark;
  programId: string;
  toPercent: (x: number, y: number) => { left: string; top: string };
  onClose: () => void;
}) {
  return (
    <div className="map-card" style={toPercent(selected.x, selected.y)}>
      <p className="map-card-name">{selected.name}</p>
      <dl className="map-card-facts">
        <dt>Distance</dt>
        <dd>
          {selected.km != null && selected.plant
            ? `${selected.km.toLocaleString('en-US')} km to ${selected.plant}`
            : 'no coordinate'}
        </dd>
        <dt>Country</dt>
        <dd>{selected.country}</dd>
        <dt>Match</dt>
        <dd>{selected.status.replace(/_/g, ' ')}</dd>
        <dt>Assessment</dt>
        <dd>{selected.assessed ? 'written' : 'not yet'}</dd>
      </dl>
      <a className="map-card-open" href={`/program/${programId}/supplier/${selected.id}`}>
        Open supplier →
      </a>
      <button type="button" className="map-card-close" aria-label="Close" onClick={onClose}>
        ×
      </button>
    </div>
  );
}

// ── The shell ──────────────────────────────────────────────────────────────

export function MapViewport({
  initial,
  worldWidth,
  worldHeight,
  minWidth,
  marks,
  plantPoints,
  programId,
  activeBands,
  regions,
  activeRegion,
  bands,
  children,
  foreground,
  overlay,
}: MapViewportProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const router = useRouter();
  const mounted = useMountedOnClient();

  const { camera, setCamera, clamp, zoomAbout, toWorld, zoomToFit, toPercent, zoomedIn } = useMapCamera({
    initial,
    worldWidth,
    worldHeight,
    minWidth,
    svgRef,
  });

  const [selected, setSelected] = useState<Mark | null>(null);
  useEscapeToDeselect(selected, setSelected);

  const { onPointerDown, onPointerMove, endDrag } = usePanDrag({
    svgRef,
    camera,
    clamp,
    setCamera,
    onDragStart: () => setSelected(null),
  });
  useWheelZoom(svgRef, toWorld, zoomAbout);

  const { tip, setTip, onMouseOver } = useMapTooltip();
  const { region, chooseRegion } = useCameraUrl({ regions, activeRegion, clamp, setCamera });
  const toggleBand = useBandFilter(router);

  return (
    /*
     * `--k` is the camera's scale, and every mark counter-scales by it so a dot
     * keeps the same size on screen at every zoom. Set here because the camera
     * is client state; consumed in CSS so no mark needs a handler or a prop.
     */
    <div
      className={mounted ? 'map-shell js' : 'map-shell'}
      style={{ '--k': camera.w / worldWidth } as React.CSSProperties}
      /*
       * Detail that only survives a close camera. All four Plants sit inside
       * 1 500 km of each other, so at world zoom their labels land on top of
       * one another and their near-band rings merge into a smear. Gated on the
       * camera rather than deleted, and server-rendered on first paint so the
       * gate is right with JavaScript off.
       */
      data-detail={camera.w <= worldWidth / 3 ? 'on' : 'off'}
      onMouseLeave={() => setTip(null)}
    >
      <MapCanvas
        svgRef={svgRef}
        camera={camera}
        worldWidth={worldWidth}
        minWidth={minWidth}
        mounted={mounted}
        marks={marks}
        plantPoints={plantPoints}
        programId={programId}
        activeBands={activeBands}
        selectedId={selected?.id ?? null}
        onSelect={setSelected}
        onZoomToFit={zoomToFit}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        endDrag={endDrag}
        onMouseOver={onMouseOver}
        onMouseOut={(event) => {
          if (!(event.relatedTarget as Element | null)?.closest?.('[data-tip]')) setTip(null);
        }}
        onDoubleClick={(event) => {
          const origin = toWorld(event.clientX, event.clientY);
          if (origin) zoomAbout(1 / 1.6, origin.x, origin.y);
        }}
        foreground={foreground}
      >
        {children}
      </MapCanvas>

      <MapCameraBadges regions={regions} region={region} onChoose={chooseRegion} />
      <MapLegend bands={bands} activeBands={activeBands} onToggle={toggleBand} />
      {overlay}
      <MapZoomControls
        zoomedIn={zoomedIn}
        atMinWidth={camera.w <= minWidth}
        onZoomOut={() => zoomAbout(1.6, camera.x + camera.w / 2, camera.y + camera.h / 2)}
        onZoomIn={() => zoomAbout(1 / 1.6, camera.x + camera.w / 2, camera.y + camera.h / 2)}
      />
      {tip && !selected ? <MapTooltipCard tip={tip} toPercent={toPercent} /> : null}
      {selected ? (
        <MapSelectedCard
          selected={selected}
          programId={programId}
          toPercent={toPercent}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </div>
  );
}

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CAMPUS_GATES, SERVICE_AREA_POLYGON } from "@rida/shared";
import { Icon } from "../components/Icon";
import { FIT, MAX_ZOOM, centreOn, makeProjection, ringPath, roadPaths, zoomAt, type Projection, type RoadData, type View } from "./geo";

/**
 * The campus drawn from CampusRide's own data, as SVG: the service area
 * (dashed green), every drivable campus road from the routing graph
 * (assets/map/campus-roads.json, from OpenStreetMap — credited in the
 * corner), the gates, and place names once zoomed in. No map tiles: no
 * outside host to allow in the CSP and nothing to pay for.
 *
 * Pan by dragging, zoom with the wheel, a pinch or the buttons; "Fit"
 * shows the whole campus. Layers are drawn by the page through `children`,
 * which gets the projection and the zoom (to keep markers the same size).
 */

const projection = makeProjection();
let roadsPromise: Promise<RoadData> | null = null;

/** The road graph, loaded once (its own small chunk) the first time a map is shown. */
function loadRoads(): Promise<RoadData> {
  roadsPromise ??= import("../../../../assets/map/campus-roads.json").then((m) => (m.default ?? m) as unknown as RoadData);
  return roadsPromise;
}

const ROAD_WIDTH: Record<string, number> = {
  primary: 5,
  secondary: 5,
  tertiary: 4,
  unclassified: 3,
  residential: 3,
  living_street: 2.5,
  service: 2,
  service_minor: 1.5,
};

export interface MapLayerProps {
  p: Projection;
  /**
   * Map units to screen pixels, zoom included: draw a marker with
   * scale(1/k) and its sizes are screen pixels, at any zoom and map size.
   */
  k: number;
  /** The zoom alone (1 = whole campus). */
  zoom: number;
}

export interface MapPlace {
  name: string;
  latitude: number;
  longitude: number;
}

export function CampusMap({
  children,
  label,
  height = 520,
  places = [],
  fit,
  compact = false,
}: {
  children?: (layer: MapLayerProps) => ReactNode;
  /** What the map shows, for screen readers. */
  label: string;
  height?: number | string;
  places?: MapPlace[];
  /** Show these points (a ride's pins, a trail) as large as they fit, when they change. */
  fit?: ReadonlyArray<{ latitude: number; longitude: number }> | null;
  compact?: boolean;
}) {
  const [roads, setRoads] = useState<RoadData | null>(null);
  const [view, setView] = useState<View>(FIT);
  const svg = useRef<SVGSVGElement>(null);
  // Screen pixels per map unit (the SVG "meets" its box), kept current as the box resizes.
  const [pxPerUnit, setPxPerUnit] = useState(0.5);
  useEffect(() => {
    const el = svg.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setPxPerUnit(Math.min(r.width / projection.width, r.height / projection.height));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const lastPinch = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    loadRoads().then((r) => alive && setRoads(r), () => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const roadLayer = useMemo(() => (roads ? roadPaths(roads, projection) : []), [roads]);
  const area = useMemo(() => ringPath(SERVICE_AREA_POLYGON, projection), []);

  const fitKey = fit?.map((pt) => `${pt.latitude.toFixed(5)},${pt.longitude.toFixed(5)}`).join("|") ?? "";
  useEffect(() => {
    if (!fit || fit.length === 0) return;
    const xy = fit.map((pt) => projection.project(pt.latitude, pt.longitude));
    const xs = xy.map((p) => p[0]);
    const ys = xy.map((p) => p[1]);
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);
    // Room around the points (half again their size), never closer than 6×.
    const zoom = Math.min(6, Math.max(1, Math.min(projection.width / Math.max(w * 1.5, 1), projection.height / Math.max(h * 1.5, 1))));
    setView(centreOn((Math.max(...xs) + Math.min(...xs)) / 2, (Math.max(...ys) + Math.min(...ys)) / 2, zoom, projection.width, projection.height));
    // The points' values, not the array's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]);

  /** A screen point in view-box units. */
  const toBox = (clientX: number, clientY: number): [number, number] => {
    const rect = svg.current!.getBoundingClientRect();
    const sx = projection.width / rect.width;
    const sy = projection.height / rect.height;
    const s = Math.max(sx, sy); // preserveAspectRatio meet
    const offX = (rect.width * s - projection.width) / 2;
    const offY = (rect.height * s - projection.height) / 2;
    return [(clientX - rect.left) * s - offX, (clientY - rect.top) * s - offY];
  };

  // Wheel zoom needs a non-passive listener to stop the page scrolling.
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const [px, py] = toBox(e.clientX, e.clientY);
      setView((v) => zoomAt(v, e.deltaY < 0 ? 1.25 : 0.8, px, py));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      if (lastPinch.current) {
        const [px, py] = toBox((a!.x + b!.x) / 2, (a!.y + b!.y) / 2);
        const factor = dist / lastPinch.current;
        setView((v) => zoomAt(v, factor, px, py));
      }
      lastPinch.current = dist;
      return;
    }
    const [x0, y0] = toBox(prev.x, prev.y);
    const [x1, y1] = toBox(e.clientX, e.clientY);
    setView((v) => ({ ...v, x: v.x + (x1 - x0), y: v.y + (y1 - y0) }));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) lastPinch.current = null;
  };

  const centre = (): [number, number] => [projection.width / 2, projection.height / 2];
  const zoom = view.k;
  /** Map units to screen pixels at this zoom (see MapLayerProps). */
  const k = view.k * pxPerUnit;

  return (
    <div className={`campus-map${compact ? " compact" : ""}`} style={{ height }}>
      <svg
        ref={svg}
        viewBox={`0 0 ${projection.width} ${projection.height}`}
        role="img"
        aria-label={label}
        className="campus-map-svg"
        onPointerDown={compact ? undefined : onPointerDown}
        onPointerMove={compact ? undefined : onPointerMove}
        onPointerUp={compact ? undefined : onPointerUp}
        onPointerCancel={compact ? undefined : onPointerUp}
      >
        <rect width={projection.width} height={projection.height} className="map-ground" />
        <g transform={`translate(${view.x} ${view.y}) scale(${zoom})`}>
          <path d={area} className="map-area-fill" />
          {roadLayer.map((r) => (
            <path key={r.cls} d={r.d} className="map-road" strokeWidth={ROAD_WIDTH[r.cls] ?? 2} vectorEffect="non-scaling-stroke" />
          ))}
          <path d={area} className="map-area" vectorEffect="non-scaling-stroke" />
          {CAMPUS_GATES.map((g) => {
            const [x, y] = projection.project(g.inside.latitude, g.inside.longitude);
            return (
              <g key={g.source} transform={`translate(${x} ${y}) scale(${1 / k})`}>
                <rect x={-5} y={-5} width={10} height={10} rx={2} className="map-gate" />
                {!compact ? (
                  <text x={8} y={4} className="map-label map-gate-label">
                    {g.name}
                  </text>
                ) : null}
              </g>
            );
          })}
          {zoom >= 3
            ? places.map((pl) => {
                const [x, y] = projection.project(pl.latitude, pl.longitude);
                return (
                  <text key={`${pl.name}:${pl.latitude}:${pl.longitude}`} transform={`translate(${x} ${y}) scale(${1 / k})`} className="map-label" textAnchor="middle">
                    {pl.name}
                  </text>
                );
              })
            : null}
          {children?.({ p: projection, k, zoom })}
        </g>
      </svg>
      {compact ? null : (
        <div className="map-controls">
          <button type="button" className="icon-button" aria-label="Zoom in" onClick={() => setView((v) => zoomAt(v, 1.5, ...centre()))} disabled={zoom >= MAX_ZOOM}>
            <Icon name="plus" />
          </button>
          <button type="button" className="icon-button" aria-label="Zoom out" onClick={() => setView((v) => zoomAt(v, 1 / 1.5, ...centre()))} disabled={zoom <= 1}>
            <Icon name="minus" />
          </button>
          <button type="button" className="icon-button" aria-label="Fit the whole campus" onClick={() => setView(FIT)}>
            <Icon name="fit" />
          </button>
        </div>
      )}
      <span className="map-credit">Map data © OpenStreetMap contributors</span>
    </div>
  );
}

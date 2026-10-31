import { SERVICE_AREA_POLYGON } from "@rida/shared";

/**
 * Turning campus coordinates into the map's SVG units: a flat
 * (equirectangular) projection with longitude shrunk by cos(latitude) —
 * exact enough for a campus a few kilometres across. North is up. The view
 * box is the service area with a margin, VIEW_WIDTH units wide.
 */

export const VIEW_WIDTH = 1000;

export interface Projection {
  width: number;
  height: number;
  project: (latitude: number, longitude: number) => [number, number];
  unproject: (x: number, y: number) => [number, number];
}

export function makeProjection(points: ReadonlyArray<readonly [number, number]> = SERVICE_AREA_POLYGON, margin = 0.04): Projection {
  const lats = points.map((p) => p[0]);
  const lngs = points.map((p) => p[1]);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const k = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
  const spanX = (maxLng - minLng) * k;
  const spanY = maxLat - minLat;
  const padX = spanX * margin;
  const padY = spanY * margin;
  const scale = VIEW_WIDTH / (spanX + 2 * padX);
  const height = (spanY + 2 * padY) * scale;
  return {
    width: VIEW_WIDTH,
    height,
    project: (lat, lng) => [((lng - minLng) * k + padX) * scale, (maxLat - lat + padY) * scale],
    unproject: (x, y) => [maxLat + padY - y / scale, minLng + (x / scale - padX) / k],
  };
}

/** The SVG path of a closed ring of [lat, lng] points. */
export function ringPath(points: ReadonlyArray<readonly [number, number]>, p: Projection): string {
  return (
    points
      .map(([lat, lng], i) => {
        const [x, y] = p.project(lat, lng);
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(" ") + " Z"
  );
}

/** The road graph file's shape (assets/map/campus-roads.json): nodes are lat/lng × 1e6, pairs flat. */
export interface RoadData {
  classes: string[];
  nodes: number[];
  ways: Array<[number, number, number, number, number[]]>;
}

export interface RoadPath {
  cls: string;
  d: string;
}

/** One SVG path per road class (fewer DOM nodes than one per road). */
export function roadPaths(data: RoadData, p: Projection): RoadPath[] {
  const byClass = new Map<string, string[]>();
  for (const [, classIndex, , , nodeIds] of data.ways) {
    const cls = data.classes[classIndex] ?? "service";
    const d = nodeIds
      .map((n, i) => {
        const [x, y] = p.project(data.nodes[n * 2]! / 1e6, data.nodes[n * 2 + 1]! / 1e6);
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(" ");
    byClass.set(cls, [...(byClass.get(cls) ?? []), d]);
  }
  return [...byClass.entries()].map(([cls, parts]) => ({ cls, d: parts.join(" ") }));
}

/** Zoom limits for the map. */
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 12;

export interface View {
  k: number;
  x: number;
  y: number;
}

export const FIT: View = { k: 1, x: 0, y: 0 };

/** Zooms by `factor` keeping the point (px, py) — in view-box units — where it is on screen. */
export function zoomAt(view: View, factor: number, px: number, py: number): View {
  const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.k * factor));
  const ratio = k / view.k;
  return { k, x: px - (px - view.x) * ratio, y: py - (py - view.y) * ratio };
}

/** The view that centres (cx, cy) at zoom k in a box of width × height. */
export function centreOn(cx: number, cy: number, k: number, width: number, height: number): View {
  return { k, x: width / 2 - cx * k, y: height / 2 - cy * k };
}

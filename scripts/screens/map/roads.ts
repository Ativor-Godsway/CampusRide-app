/**
 * The roads around Legon (assets/map/legon-osm.json, from scripts/map/fetch-legon.mjs) for `--map-art`:
 * stubs/maps.tsx draws them, and roadPath() routes the harness's trips along
 * them so a route line follows real roads instead of cutting across campus.
 *
 * Map data © OpenStreetMap contributors (ODbL).
 */
import data from "../../../assets/map/legon-osm.json";

export interface LatLng {
  latitude: number;
  longitude: number;
}

export const MAP_ATTRIBUTION = "© OpenStreetMap contributors";

/** Node i's position. */
export const point = (i: number): LatLng => ({
  latitude: data.nodes[2 * i] / 1e5,
  longitude: data.nodes[2 * i + 1] / 1e5,
});

/** Roads widest first: [class, oneway, node indexes]. Class 0 is a trunk road, 4 a service road. */
export const roads = [...(data.roads as [number, number, number[]][])].sort((a, b) => b[0] - a[0]);
/** [kind (0 green, 1 water), outline node indexes]. */
export const areas = data.areas as [number, number[]][];

/** Metres between two points (haversine). */
export function metres(a: LatLng, b: LatLng): number {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLng = (b.longitude - a.longitude) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

// Graph of the drivable roads (service roads included: halls sit on them).
const edges = new Map<number, [number, number][]>();
for (const [, oneway, nodes] of roads) {
  for (let i = 1; i < nodes.length; i++) {
    const [a, b] = [nodes[i - 1], nodes[i]];
    const d = metres(point(a), point(b));
    if (!edges.has(a)) edges.set(a, []);
    if (!edges.has(b)) edges.set(b, []);
    edges.get(a)!.push([b, d]);
    if (!oneway) edges.get(b)!.push([a, d]);
  }
}

function nearestNode(p: LatLng): number {
  let best = -1;
  let bestD = Infinity;
  for (const n of edges.keys()) {
    const d = metres(p, point(n));
    if (d < bestD) [best, bestD] = [n, d];
  }
  return best;
}

/** Shortest road path between two nodes (Dijkstra), or null when they aren't connected. */
function shortest(from: number, to: number): number[] | null {
  const dist = new Map<number, number>([[from, 0]]);
  const prev = new Map<number, number>();
  const open = new Set([from]);
  while (open.size) {
    let u = -1;
    let du = Infinity;
    for (const n of open) {
      const d = dist.get(n)!;
      if (d < du) [u, du] = [n, d];
    }
    if (u === to) break;
    open.delete(u);
    for (const [v, w] of edges.get(u) ?? []) {
      const dv = du + w;
      if (dv < (dist.get(v) ?? Infinity)) {
        dist.set(v, dv);
        prev.set(v, u);
        open.add(v);
      }
    }
  }
  if (!dist.has(to)) return null;
  const path = [to];
  while (path[0] !== from) path.unshift(prev.get(path[0])!);
  return path;
}

/**
 * A road route through `stops` in order: each leg from the road nearest one
 * stop to the road nearest the next, starting and ending on the stops
 * themselves. A leg the roads can't join is a straight line.
 */
export function roadPath(stops: LatLng[]): { points: LatLng[]; legMetres: number[] } {
  const points: LatLng[] = [];
  const legMetres: number[] = [];
  for (let i = 1; i < stops.length; i++) {
    const path = shortest(nearestNode(stops[i - 1]), nearestNode(stops[i]));
    const leg = [stops[i - 1], ...(path ?? []).map(point), stops[i]];
    legMetres.push(leg.slice(1).reduce((sum, p, j) => sum + metres(leg[j], p), 0));
    points.push(...(i === 1 ? leg : leg.slice(1)));
  }
  return { points, legMetres };
}

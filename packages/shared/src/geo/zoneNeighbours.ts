import { haversineDistanceMeters, nearestZone } from "./distance";
import { SERVICE_AREA_POLYGON, pointInPolygon, type PolygonPoint } from "./serviceArea";

/**
 * Which zones are real neighbours (2026-11-24): the pairs dispatch treats as
 * "next door" (ZoneAdjacency). Before this every zone was adjacent to every
 * other (a full mesh), so "the pickup zone and its neighbours" meant every
 * online driver on campus.
 *
 * Zones are points: a spot on campus belongs to the nearest zone centre. So
 * a zone's area is its Voronoi cell inside the service area, and two zones
 * TOUCH when their cells share a border. Two zones are neighbours when:
 *
 * - their cells share at least NEIGHBOUR_MIN_BORDER_METERS of border (a
 *   corner or a sliver along the campus edge doesn't count: Great Hall and
 *   UGMC, 2.4 km apart, meet for under 100 m there), or
 * - their centres are at most NEIGHBOUR_MAX_CENTRE_METERS apart.
 *
 * The cells are measured on a grid (GRID_METERS), which is plenty at campus
 * scale and needs no geometry library. Admins can change the result by hand
 * (admin site, Places → Zone neighbours); this is the suggestion.
 */

export const NEIGHBOUR_MAX_CENTRE_METERS = 800;
export const NEIGHBOUR_MIN_BORDER_METERS = 150;
const GRID_METERS = 10;
const METERS_PER_DEGREE = 111_320;

export interface NeighbourZone {
  id: string;
  latitude: number;
  longitude: number;
}

export interface ZoneNeighbourPair {
  /** The two zone ids, in sorted order (a < b). */
  a: string;
  b: string;
  centreMeters: number;
  borderMeters: number;
}

/** A pair's key, the same whichever way round it is given. */
export function zonePairKey(x: string, y: string): string {
  return x < y ? `${x}|${y}` : `${y}|${x}`;
}

/** Every neighbour pair among `zones`, sorted by centre distance. */
export function computeZoneNeighbours(
  zones: readonly NeighbourZone[],
  polygon: readonly PolygonPoint[] = SERVICE_AREA_POLYGON,
  options: { gridMeters?: number; maxCentreMeters?: number; minBorderMeters?: number } = {},
): ZoneNeighbourPair[] {
  const step = options.gridMeters ?? GRID_METERS;
  const maxCentre = options.maxCentreMeters ?? NEIGHBOUR_MAX_CENTRE_METERS;
  const minBorder = options.minBorderMeters ?? NEIGHBOUR_MIN_BORDER_METERS;
  if (zones.length < 2 || polygon.length < 3) return [];

  const lats = polygon.map((p) => p[0]);
  const lngs = polygon.map((p) => p[1]);
  const minLat = Math.min(...lats);
  const minLng = Math.min(...lngs);
  const midLat = (minLat + Math.max(...lats)) / 2;
  const dLat = step / METERS_PER_DEGREE;
  const dLng = step / (METERS_PER_DEGREE * Math.cos((midLat * Math.PI) / 180));
  const rows = Math.ceil((Math.max(...lats) - minLat) / dLat) + 1;
  const cols = Math.ceil((Math.max(...lngs) - minLng) / dLng) + 1;

  // Which zone each grid point inside the area belongs to (-1 outside).
  const cell = new Int32Array(rows * cols).fill(-1);
  for (let i = 0; i < rows; i++) {
    const latitude = minLat + i * dLat;
    for (let j = 0; j < cols; j++) {
      const longitude = minLng + j * dLng;
      if (!pointInPolygon({ latitude, longitude }, polygon)) continue;
      const zone = nearestZone(latitude, longitude, zones);
      cell[i * cols + j] = zone ? zones.indexOf(zone) : -1;
    }
  }

  // Border length between each pair: one grid step per pair of unlike grid neighbours.
  const border = new Map<string, number>();
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const here = cell[i * cols + j]!;
      if (here < 0) continue;
      const right = j + 1 < cols ? cell[i * cols + j + 1]! : -1;
      const below = i + 1 < rows ? cell[(i + 1) * cols + j]! : -1;
      for (const other of [right, below]) {
        if (other < 0 || other === here) continue;
        const key = zonePairKey(zones[here]!.id, zones[other]!.id);
        border.set(key, (border.get(key) ?? 0) + step);
      }
    }
  }

  const pairs: ZoneNeighbourPair[] = [];
  for (let x = 0; x < zones.length; x++) {
    for (let y = x + 1; y < zones.length; y++) {
      const p = zones[x]!;
      const q = zones[y]!;
      if (p.id === q.id) continue;
      const centreMeters = Math.round(haversineDistanceMeters(p, q));
      const borderMeters = border.get(zonePairKey(p.id, q.id)) ?? 0;
      if (borderMeters >= minBorder || centreMeters <= maxCentre) {
        const [a, b] = p.id < q.id ? [p.id, q.id] : [q.id, p.id];
        pairs.push({ a, b, centreMeters, borderMeters });
      }
    }
  }
  return pairs.sort((m, n) => m.centreMeters - n.centreMeters || zonePairKey(m.a, m.b).localeCompare(zonePairKey(n.a, n.b)));
}

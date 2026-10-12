/**
 * Where CampusRide runs: the University of Ghana (Legon) campus, about 200 m
 * around it, and the N4 corridor south to Accra Mall. A pickup or drop-off
 * outside it is refused, and a driver outside it gets no zone (so no
 * requests).
 *
 * Built from the OpenStreetMap campus boundary (way 308668766): its convex
 * hull (the boundary fills 92% of it) pushed 200 m outwards, with the
 * corridor to Accra Mall spliced in at the south-east. Points are
 * [latitude, longitude], in order around the edge. To change the area, edit
 * this list; the server serves it from GET /service-area, so the apps pick up
 * a change from the server they talk to.
 */
import { nearestZone } from "./distance";
import type { LatLng } from "../driver/requestsNearYou";

export type PolygonPoint = readonly [latitude: number, longitude: number];

export const SERVICE_AREA_POLYGON: readonly PolygonPoint[] = [
  [5.65923, -0.2068],
  [5.6564, -0.20688],
  [5.65239, -0.20694],
  [5.64649, -0.2068],
  [5.64497, -0.20655],
  [5.62557, -0.19339],
  [5.62508, -0.19016],
  [5.62439, -0.18459],
  // Corridor down the N4: Okponglo, Shiashie, Tetteh Quarshie, Accra Mall.
  [5.6178, -0.1815],
  [5.6178, -0.17],
  [5.629, -0.1678],
  [5.64164, -0.16974],
  [5.64644, -0.16782],
  [5.64884, -0.16751],
  [5.65846, -0.16751],
  [5.66713, -0.17659],
  [5.66843, -0.17992],
  [5.66887, -0.18164],
  [5.66913, -0.19023],
  [5.66263, -0.20513],
  [5.66187, -0.20594],
  [5.65971, -0.20677],
];

/** Ray casting; fine at campus scale (a few km, nowhere near a pole). */
export function pointInPolygon(point: LatLng, polygon: readonly PolygonPoint[]): boolean {
  const { latitude: y, longitude: x } = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [yi, xi] = polygon[i]!;
    const [yj, xj] = polygon[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function isInServiceArea(point: LatLng, polygon: readonly PolygonPoint[] = SERVICE_AREA_POLYGON): boolean {
  return Number.isFinite(point.latitude) && Number.isFinite(point.longitude) && pointInPolygon(point, polygon);
}

/** What a rider is told when a pickup or drop-off is outside the area. */
export function outsideServiceAreaMessage(end: "pickup" | "dropoff"): string {
  const what = end === "pickup" ? "That pickup" : "That drop-off";
  return `${what} is outside the CampusRide area. We cover the University of Ghana campus and nearby, down to Accra Mall.`;
}

/**
 * The zone a point belongs to: the nearest zone centre, for any point inside
 * the service area; null outside it. Zones are invisible neighbourhoods, so
 * a point always gets one, however far it is from that zone's centre.
 */
export function zoneForPoint<T extends LatLng>(
  point: LatLng,
  zones: readonly T[],
  polygon: readonly PolygonPoint[] = SERVICE_AREA_POLYGON,
): T | null {
  if (!isInServiceArea(point, polygon)) return null;
  return nearestZone(point.latitude, point.longitude, zones);
}

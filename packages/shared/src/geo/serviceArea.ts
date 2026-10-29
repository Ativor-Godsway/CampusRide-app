/**
 * Where CampusRide runs: the University of Ghana (Legon) campus, west of
 * J.J. Rawlings Avenue. A pickup, drop-off or pin outside it is refused, and
 * a driver outside it can't go online and gets no zone (so no requests).
 *
 * The polygon is SERVICE_AREA_POLYGON in serviceAreaPolygon.ts, GENERATED from
 * assets/map/service-area.geojson by scripts/map/service-area.mjs: the OSM
 * campus outline (way 308668766) with no buffer, minus J.J. Rawlings Avenue
 * (30 m either side), everything east of it, and the Main and Stadium gates'
 * approach roads. To change the area, edit the GeoJSON (geojson.io) and run
 * the script. The apps and the admin site use the copy built into them, so
 * a change reaches them with an app update (OTA) and the server with a
 * deploy; GET /service-area serves the server's copy to other clients.
 */
import { nearestZone } from "./distance";
import { SERVICE_AREA_POLYGON } from "./serviceAreaPolygon";
import type { LatLng } from "../driver/requestsNearYou";

export type PolygonPoint = readonly [latitude: number, longitude: number];

export { SERVICE_AREA_POLYGON };

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
  return `${what} is outside campus. CampusRide only works on the University of Ghana (Legon) campus.`;
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

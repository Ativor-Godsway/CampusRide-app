/**
 * The driver's side of the CampusRide service area (geo/serviceArea.ts): a
 * driver inside the area is in the nearest zone; outside it they get no zone
 * (so no requests) and can't go online — the app says "You're outside the
 * CampusRide area" instead of offering requests 122 km away.
 *
 * Until 2026-10 the area was "within 2 km of a zone centre"; it is now the
 * same polygon riders' pickups and drop-offs are checked against.
 */
import { SERVICE_AREA_POLYGON, zoneForPoint, type PolygonPoint } from "../geo/serviceArea";

/** What the driver is told when they try to go online outside the area. */
export const DRIVER_OUTSIDE_AREA_MESSAGE =
  "CampusRide works on the University of Ghana (Legon) campus. Go online when you're on campus.";

/** The nearest zone if the position is inside the service area, else null. */
export function zoneInServiceArea<T extends { latitude: number; longitude: number }>(
  position: { latitude: number; longitude: number },
  zones: readonly T[],
  polygon: readonly PolygonPoint[] = SERVICE_AREA_POLYGON,
): T | null {
  return zoneForPoint(position, zones, polygon);
}

export function isOutsideServiceArea(
  position: { latitude: number; longitude: number } | null,
  zones: readonly { latitude: number; longitude: number }[],
  polygon: readonly PolygonPoint[] = SERVICE_AREA_POLYGON,
): boolean {
  return position !== null && zones.length > 0 && zoneInServiceArea(position, zones, polygon) === null;
}

/**
 * The CampusRide service area: within SERVICE_AREA_RADIUS_METERS of at least
 * one campus zone. A driver further out than that gets no zone (so no
 * requests) and can't go online — the app says "You're outside the
 * CampusRide area" instead of offering requests 122 km away.
 */
import { haversineDistanceMeters } from "../geo/distance";

export const SERVICE_AREA_RADIUS_METERS = 2_000;

/** The nearest zone if it's within the service area, else null. */
export function zoneInServiceArea<T extends { latitude: number; longitude: number }>(
  position: { latitude: number; longitude: number },
  zones: readonly T[],
  radiusMeters = SERVICE_AREA_RADIUS_METERS,
): T | null {
  let best: T | null = null;
  let bestDistance = Infinity;
  for (const z of zones) {
    const d = haversineDistanceMeters(position, z);
    if (d < bestDistance) {
      bestDistance = d;
      best = z;
    }
  }
  return best && bestDistance <= radiusMeters ? best : null;
}

export function isOutsideServiceArea(
  position: { latitude: number; longitude: number } | null,
  zones: readonly { latitude: number; longitude: number }[],
): boolean {
  return position !== null && zones.length > 0 && zoneInServiceArea(position, zones) === null;
}

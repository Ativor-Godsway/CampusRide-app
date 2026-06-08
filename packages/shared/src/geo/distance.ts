/**
 * Pure geo helpers — no device APIs. Used by the rider app to map a GPS
 * fix to the nearest campus zone, and by the driver app (Phase 6) for the
 * same purpose.
 */

import type { Zone } from "../types/zone";

const EARTH_RADIUS_METERS = 6_371_000;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Great-circle distance between two lat/lng points, in meters. */
export function haversineDistanceMeters(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const dLat = toRadians(b.latitude - a.latitude);
  const dLng = toRadians(b.longitude - a.longitude);

  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);

  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));

  return EARTH_RADIUS_METERS * c;
}

/**
 * Returns the zone whose center is closest (great-circle distance) to the
 * given coordinates. Returns `null` if `zones` is empty.
 */
export function nearestZone<T extends Pick<Zone, "latitude" | "longitude">>(
  latitude: number,
  longitude: number,
  zones: readonly T[],
): T | null {
  let closest: T | null = null;
  let closestDistance = Infinity;

  for (const zone of zones) {
    const distance = haversineDistanceMeters({ latitude, longitude }, zone);
    if (distance < closestDistance) {
      closestDistance = distance;
      closest = zone;
    }
  }

  return closest;
}

/**
 * Returns all zones within `radiusMeters` of the given coordinates,
 * sorted nearest-first.
 */
export function zonesWithinRadius<T extends Pick<Zone, "latitude" | "longitude">>(
  latitude: number,
  longitude: number,
  zones: readonly T[],
  radiusMeters: number,
): T[] {
  return zones
    .map((zone) => ({ zone, distance: haversineDistanceMeters({ latitude, longitude }, zone) }))
    .filter(({ distance }) => distance <= radiusMeters)
    .sort((a, b) => a.distance - b.distance)
    .map(({ zone }) => zone);
}

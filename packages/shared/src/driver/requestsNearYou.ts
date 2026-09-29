import { haversineDistanceMeters } from "../geo/distance";
import type { RideType } from "../types/ride";

/** The driver's "Requests near you" filter chips. */
export type RequestTypeFilter = "ALL" | "SHARED" | "LONE";

export interface LatLng {
  latitude: number;
  longitude: number;
}

interface NearYouRequest {
  pickupZoneId: string;
  type: RideType;
  createdAt: string;
}

export type WithDistance<T> = T & {
  /** Metres from the driver to the pickup zone's centre, or null when unknown. */
  distanceMeters: number | null;
};

/**
 * Nearest pickup first. Distance is from the driver's latest GPS fix to the
 * pickup zone's centre; without a fix (or an unknown zone) a request sorts
 * after every measured one. Ties, and the unmeasured tail, fall back to the
 * oldest request first, since that rider has waited longest.
 */
export function sortRequestsNearestFirst<T extends NearYouRequest>(
  requests: readonly T[],
  driver: LatLng | null,
  zones: readonly ({ id: string } & LatLng)[],
): WithDistance<T>[] {
  const zoneById = new Map(zones.map((z) => [z.id, z]));
  return requests
    .map((r) => {
      const zone = zoneById.get(r.pickupZoneId);
      const distanceMeters = driver && zone ? haversineDistanceMeters(driver, zone) : null;
      return { ...r, distanceMeters };
    })
    .sort((a, b) => {
      if (a.distanceMeters !== null && b.distanceMeters !== null && a.distanceMeters !== b.distanceMeters) {
        return a.distanceMeters - b.distanceMeters;
      }
      if (a.distanceMeters === null && b.distanceMeters !== null) return 1;
      if (a.distanceMeters !== null && b.distanceMeters === null) return -1;
      return Date.parse(a.createdAt) - Date.parse(b.createdAt);
    });
}

export function filterRequestsByType<T extends { type: RideType }>(
  requests: readonly T[],
  filter: RequestTypeFilter,
): T[] {
  return filter === "ALL" ? [...requests] : requests.filter((r) => r.type === filter);
}

/** "350 m" under a kilometre, "1.4 km" above. Rounded, because zone centres are approximate. */
export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return "";
  const rounded = Math.max(50, Math.round(meters / 50) * 50);
  if (rounded < 1000) return `${rounded} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

/** "Requested just now" / "Requested 3 min ago". */
export function requestedAgo(createdAt: string, now: number = Date.now()): string {
  const mins = Math.floor((now - Date.parse(createdAt)) / 60_000);
  if (!Number.isFinite(mins) || mins < 1) return "Requested just now";
  return `Requested ${mins} min ago`;
}

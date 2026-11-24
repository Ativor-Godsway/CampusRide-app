/**
 * Refused bookings (2026-11-24): demand that never became a ride. Each time
 * the server refuses a ride request it keeps an anonymous record — when,
 * where from and to (place or zone), and why — with nothing that says who
 * asked (no rider id, no phone, no exact pin).
 *
 * Two stages, because current rider apps grey out Request while CampusRide
 * is closed or has no driver online, so most of that demand never reaches
 * POST /rides:
 * - REQUEST: the rider tapped Request and the server refused it.
 * - QUOTE: the rider opened Choose a ride for a trip while booking was
 *   blocked (the server answers the fare quote, and the app shows Request
 *   disabled). Counted once per rider and trip per half hour, in memory only.
 */
export const REFUSED_BOOKING_REASONS = [
  "SERVICE_CLOSED",
  "NO_DRIVERS_ONLINE",
  "LAUNCH_NOT_OPEN",
  "OUTSIDE_SERVICE_AREA",
  "PLACE_NOT_FOUND",
  "ZONE_NOT_SERVED",
  "TRIP_TOO_SHORT",
  "ACTIVE_RIDE_EXISTS",
] as const;
export type RefusedBookingReason = (typeof REFUSED_BOOKING_REASONS)[number];

export const REFUSED_BOOKING_STAGES = ["REQUEST", "QUOTE"] as const;
export type RefusedBookingStage = (typeof REFUSED_BOOKING_STAGES)[number];

export const REFUSED_BOOKING_REASON_LABELS: Record<RefusedBookingReason, string> = {
  SERVICE_CLOSED: "Outside service hours",
  NO_DRIVERS_ONLINE: "No drivers online",
  LAUNCH_NOT_OPEN: "Before launch",
  OUTSIDE_SERVICE_AREA: "Outside the service area",
  PLACE_NOT_FOUND: "Place no longer listed",
  ZONE_NOT_SERVED: "Zone not served (old app)",
  TRIP_TOO_SHORT: "Same pickup and drop-off",
  ACTIVE_RIDE_EXISTS: "Already had a ride",
};

export function isRefusedBookingReason(v: unknown): v is RefusedBookingReason {
  return typeof v === "string" && (REFUSED_BOOKING_REASONS as readonly string[]).includes(v);
}

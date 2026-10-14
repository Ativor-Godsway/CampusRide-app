import { haversineDistanceMeters } from "@rida/shared";

/**
 * "Your driver is almost at your pickup" (DRIVER_ARRIVING). There is no
 * arriving status in the ride state machine, so it is worked out from the
 * driver's live location as it streams in (realtime/rideSocket.ts).
 *
 * A waiting rider is told once when the driver comes within
 * ARRIVING_RADIUS_METERS of their pickup — roughly a minute out at campus
 * speeds. Not in the first ARRIVING_MIN_AFTER_JOIN_MS after they were matched:
 * a driver accepting from around the corner would otherwise send "on the
 * way" and "almost there" in the same breath.
 */
export const ARRIVING_RADIUS_METERS = 350;
export const ARRIVING_MIN_AFTER_JOIN_MS = 60_000;

export interface ArrivingCandidate {
  id: string;
  riderId: string;
  status: string;
  /** When the rider joined this car (RidePassenger.createdAt). */
  joinedAt: Date;
  /** Their exact pickup pin, or the pickup zone's centre; null if unknown. */
  pickup: { latitude: number; longitude: number } | null;
}

export function passengersToAlertArriving(
  driver: { latitude: number; longitude: number },
  passengers: readonly ArrivingCandidate[],
  now: Date,
): ArrivingCandidate[] {
  return passengers.filter(
    (p) =>
      p.status === "WAITING" &&
      p.pickup !== null &&
      now.getTime() - p.joinedAt.getTime() >= ARRIVING_MIN_AFTER_JOIN_MS &&
      haversineDistanceMeters(driver, p.pickup) <= ARRIVING_RADIUS_METERS,
  );
}

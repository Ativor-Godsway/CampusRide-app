/**
 * How an online driver's app shares its position with the server
 * (apps/driver/lib/positionSender.ts): during a trip, for the riders on it
 * (DRIVER_CLIENT_EVENTS.LOCATION_UPDATE); online without a trip, for riders'
 * Home maps and the online records (POSITION_UPDATE).
 *
 * Positions go out as each new fix arrives — including from the background
 * location task, because Android pauses an app's JS timers while it is in
 * the background or the screen is locked, so a timer alone stopped sending
 * there. A timer still re-sends the latest fix while timers run (the app in
 * front, and iPhone in the background).
 */

/** At most one trip position this often (the server relays one per 2 s). */
export const TRIP_POSITION_EVERY_MS = 4_000;
/** At most one idle position this often (battery; riders' maps ask every 10 s). */
export const IDLE_POSITION_EVERY_MS = 15_000;

export interface PositionSharingState {
  /** The trip under way, if any. */
  rideId: string | null;
  online: boolean;
  /** When the last position was sent, and for which (null: none yet). */
  lastSentAt: number | null;
  lastSentFor: string | null;
}

/** What to send now: a trip position, an idle one, or nothing (too soon, or not sharing). */
export function positionToSend(
  state: PositionSharingState,
  now: number,
): { kind: "trip"; rideId: string } | { kind: "idle" } | null {
  const target = state.rideId ?? (state.online ? "idle" : null);
  if (target === null) return null;
  const every = state.rideId ? TRIP_POSITION_EVERY_MS : IDLE_POSITION_EVERY_MS;
  // A new trip (or the end of one) sends at once; otherwise wait out the interval.
  if (state.lastSentFor === target && state.lastSentAt !== null && now - state.lastSentAt < every) return null;
  return state.rideId ? { kind: "trip", rideId: state.rideId } : { kind: "idle" };
}

export type DriverLocationMode = "trip" | "idle";

/**
 * The background location task's cadence. Android: a fix every 5 s on a
 * trip and every 15 s otherwise, whether or not the car moves, so the
 * server keeps hearing a parked car in the background. iPhone: unchanged
 * (its timers keep running in the background, and it ignores timeInterval):
 * a fix when the car has moved 10 m.
 */
export function driverLocationCadence(
  platform: string,
  mode: DriverLocationMode,
): { timeInterval: number; distanceInterval: number } {
  if (platform === "android") {
    return { timeInterval: mode === "trip" ? 5_000 : IDLE_POSITION_EVERY_MS, distanceInterval: 0 };
  }
  return { timeInterval: 5_000, distanceInterval: 10 };
}

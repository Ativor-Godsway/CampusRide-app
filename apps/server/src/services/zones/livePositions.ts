import { HEADING_MIN_MOVE_METERS, bearingBetween, haversineDistanceMeters, type LatLng } from "@rida/shared";

/**
 * Where each driver's app last said they were, in this server's memory
 * only: no database write per position. Fed by the driver sockets
 * (realtime/rideSocket.ts) — DRIVER_CLIENT_EVENTS.POSITION_UPDATE while
 * online without a trip, LOCATION_UPDATE during one — and read by the
 * riders' Home map (services/ride/nearbyCars.ts).
 *
 * Lost on a restart: drivers' apps send again within seconds, and until
 * then the map simply shows fewer cars. The API runs as one instance; a
 * second one would need these in Redis (like the rate-limit counters).
 *
 * Driver.lastLat/lastLng (written on going online and on a zone change) are
 * a different thing: the server's zone check and the admin live map.
 */

export interface LivePosition extends LatLng {
  /** Compass degrees the car was last seen moving; null until it has moved. */
  heading: number | null;
  /** When it arrived (epoch ms). */
  at: number;
  /** The trip it was sent with (a trip position), null for an idle driver's. Admin live map. */
  rideId: string | null;
}

/** Older than this, a position no longer gives a heading to the next one. */
const HEADING_KEEP_MS = 2 * 60_000;
/** Positions this old are swept away. */
const FORGET_AFTER_MS = 10 * 60_000;
/** Far more drivers than a campus has; past it the oldest go first. */
const MAX_DRIVERS = 5_000;

const positions = new Map<string, LivePosition>();

/**
 * Records a driver's position; the heading comes from how they moved since
 * the last one. `rideId`: the trip it was sent with, if any.
 */
export function recordDriverPosition(
  userId: string,
  point: LatLng,
  now: number = Date.now(),
  rideId: string | null = null,
): void {
  const prev = positions.get(userId);
  let heading = prev && now - prev.at < HEADING_KEEP_MS ? prev.heading : null;
  // Smaller moves are GPS jitter: a parked car keeps the way it was facing.
  if (prev && now - prev.at < HEADING_KEEP_MS && haversineDistanceMeters(prev, point) >= HEADING_MIN_MOVE_METERS) {
    heading = bearingBetween(prev, point);
  }
  // Re-inserted, so the Map stays oldest-first for the size cap below.
  positions.delete(userId);
  positions.set(userId, { latitude: point.latitude, longitude: point.longitude, heading, at: now, rideId });
  if (positions.size > MAX_DRIVERS) {
    const oldest = positions.keys().next().value;
    if (oldest !== undefined) positions.delete(oldest);
  }
}

/** Every driver heard from within `freshMs`, with where they are. */
export function freshDriverPositions(freshMs: number, now: number = Date.now()): Map<string, LivePosition> {
  const out = new Map<string, LivePosition>();
  for (const [userId, p] of positions) if (now - p.at <= freshMs) out.set(userId, p);
  return out;
}

/** Forgets positions nobody will ask for again. Called on a timer (index.ts). */
export function sweepLivePositions(now: number = Date.now()): void {
  for (const [userId, p] of positions) if (now - p.at > FORGET_AFTER_MS) positions.delete(userId);
}

/** Tests only. */
export function resetLivePositionsForTests(): void {
  positions.clear();
}

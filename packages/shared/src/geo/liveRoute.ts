/**
 * Following a road route as the car moves, without asking for a new one on
 * every GPS fix. A route is asked for once (POST /routes/legs, OSRM behind
 * it) and then trimmed to the car's position as it drives; a new one is
 * asked for only when the car has left the drawn road — and not more often
 * than REROUTE_MIN_INTERVAL_MS — which keeps OSRM calls to a few per trip.
 */
import { haversineDistanceMeters } from "./distance";
import { pathLengthMeters, type PathPoint } from "./polyline";
import { ON_ROUTE_METERS } from "./tripRoute";

/** Never re-ask for a route sooner than this after the last ask. */
export const REROUTE_MIN_INTERVAL_MS = 30_000;

/** Metres from `point` to the nearest point of `path` (flat-earth maths; fine across a campus). */
export function distanceToPathMeters(point: PathPoint, path: readonly PathPoint[]): number {
  if (path.length === 0) return Infinity;
  if (path.length === 1) return haversineDistanceMeters(point, path[0]!);
  const kx = Math.cos((point.latitude * Math.PI) / 180);
  let best = Infinity;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    const dx = (b.longitude - a.longitude) * kx;
    const dy = b.latitude - a.latitude;
    const len2 = dx * dx + dy * dy;
    const t =
      len2 === 0
        ? 0
        : Math.max(0, Math.min(1, ((point.longitude - a.longitude) * kx * dx + (point.latitude - a.latitude) * dy) / len2));
    const closest = { latitude: a.latitude + dy * t, longitude: a.longitude + (b.longitude - a.longitude) * t };
    best = Math.min(best, haversineDistanceMeters(point, closest));
  }
  return best;
}

/** True when `position` is within `toleranceMeters` of the drawn road. */
export function isOnRoute(position: PathPoint, path: readonly PathPoint[], toleranceMeters = ON_ROUTE_METERS): boolean {
  return distanceToPathMeters(position, path) <= toleranceMeters;
}

/**
 * Whether to ask for a new route now:
 * - the stops changed (a new route is needed at once);
 * - the last ask failed (try again, but not within REROUTE_MIN_INTERVAL_MS);
 * - the car has left the road it was given (likewise rate-limited).
 * `stopsKey` must leave out the car's own position, which changes all the time.
 */
export function shouldReroute(input: {
  hasRoute: boolean;
  routedFor: string | null;
  stopsKey: string;
  position: PathPoint | null;
  path: readonly PathPoint[];
  lastAskedAt: number | null;
  now: number;
}): boolean {
  const { hasRoute, routedFor, stopsKey, position, path, lastAskedAt, now } = input;
  if (routedFor !== stopsKey) return true;
  const recently = lastAskedAt !== null && now - lastAskedAt < REROUTE_MIN_INTERVAL_MS;
  if (recently) return false;
  if (!hasRoute) return true;
  return position !== null && !isOnRoute(position, path);
}

/** A key for a list of points, rounded to ~11 m (as the server caches them). */
export function pointsKey(points: readonly PathPoint[]): string {
  return points.map((p) => `${p.latitude.toFixed(4)},${p.longitude.toFixed(4)}`).join("|");
}

/**
 * Seconds left on a leg the car is part-way along: the leg's time scaled by
 * how much of its road is still ahead. Null without a usable route.
 */
export function remainingSeconds(
  fullPath: readonly PathPoint[],
  aheadPath: readonly PathPoint[],
  durationSeconds: number,
): number | null {
  const total = pathLengthMeters(fullPath);
  if (!(total > 0) || !Number.isFinite(durationSeconds)) return null;
  const ahead = Math.min(total, pathLengthMeters(aheadPath));
  return Math.max(0, durationSeconds * (ahead / total));
}

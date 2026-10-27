/**
 * Which way the driver's car faces on a map. Pure maths, no device APIs: the
 * map marker (mobile-shared CarMarker) feeds it GPS fixes and the drawn route
 * and turns the car image by the result.
 *
 * Angles are compass degrees: 0 = north, 90 = east, clockwise.
 */
import { haversineDistanceMeters } from "./distance";
import type { PathPoint } from "./polyline";

/** Moves shorter than this between two fixes are GPS jitter: a parked car keeps its heading. */
export const HEADING_MIN_MOVE_METERS = 3;
/** The car follows the road's direction only when it is this close to the drawn route. */
export const HEADING_ROUTE_METERS = 30;

/** `degrees` folded into [0, 360). */
export function normalizeDegrees(degrees: number): number {
  const d = degrees % 360;
  // `+ 0` turns -0 (from e.g. -360 % 360) into 0.
  return d < 0 ? d + 360 : d + 0;
}

/** Compass bearing in degrees (0 = north) from `a` to `b`. */
export function bearingBetween(a: PathPoint, b: PathPoint): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLon = toRad(b.longitude - a.longitude);
  const y = Math.sin(dLon) * Math.cos(toRad(b.latitude));
  const x =
    Math.cos(toRad(a.latitude)) * Math.sin(toRad(b.latitude)) -
    Math.sin(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.cos(dLon);
  return normalizeDegrees((Math.atan2(y, x) * 180) / Math.PI);
}

/**
 * The signed turn from `from` to `to` the short way round, in (-180, 180]:
 * 350 → 10 is +20, not -340.
 */
export function shortestTurn(from: number, to: number): number {
  const d = normalizeDegrees(to - from);
  return d > 180 ? d - 360 : d;
}

/**
 * Where an animated angle should go next so that it turns the short way to
 * `target`. `current` may be outside [0, 360) (an animated value keeps
 * counting past a full turn); the result is `current` plus the short turn.
 */
export function continueAngle(current: number, target: number): number {
  return current + shortestTurn(current, target);
}

/**
 * The angle to draw the car at on screen when the map itself is turned to
 * `mapHeading` (the compass direction at the top of the screen): a car
 * heading east (90) on a map turned to 90 points straight up (0).
 */
export function screenAngle(bearing: number, mapHeading: number): number {
  return normalizeDegrees(bearing - mapHeading);
}

/**
 * The road's direction where the car is: the bearing of the route segment
 * nearest `point`, or null when the car is more than `maxMeters` from the
 * route (or there is no route).
 *
 * A route trimmed to the car (trimPathToPosition) starts with a short line
 * from the car to its spot on the road; that line is not road, so a first
 * segment that starts at the car is skipped. Segments shorter than a metre
 * (repeated points) are skipped too. At a corner, where the segment in and
 * the segment out are equally near, the one ahead wins.
 */
export function routeBearingAt(
  point: PathPoint,
  route: readonly PathPoint[] | null | undefined,
  maxMeters = HEADING_ROUTE_METERS,
): number | null {
  if (!route || route.length < 2) return null;
  const kx = Math.cos((point.latitude * Math.PI) / 180);
  let bestDistance = Infinity;
  let bestBearing: number | null = null;
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1]!;
    const b = route[i]!;
    if (haversineDistanceMeters(a, b) < 1) continue;
    if (i === 1 && haversineDistanceMeters(a, point) < 1) continue;
    const dx = (b.longitude - a.longitude) * kx;
    const dy = b.latitude - a.latitude;
    const len2 = dx * dx + dy * dy;
    const t = Math.max(0, Math.min(1, ((point.longitude - a.longitude) * kx * dx + (point.latitude - a.latitude) * dy) / len2));
    const closest = { latitude: a.latitude + dy * t, longitude: a.longitude + (b.longitude - a.longitude) * t };
    const distance = haversineDistanceMeters(point, closest);
    // Within half a metre counts as a tie, and on a tie the later segment wins.
    if (distance <= maxMeters && distance <= bestDistance + 0.5) {
      bestDistance = Math.min(distance, bestDistance);
      bestBearing = bearingBetween(a, b);
    }
  }
  return bestBearing;
}

/**
 * The car's heading after a new GPS fix.
 *
 * - On (or near) the drawn route: the road's direction there, so the car
 *   follows the road rather than GPS wobble — unless the car is plainly
 *   moving the other way (more than 90° off), when its own movement wins.
 * - Otherwise: the bearing from the previous fix to this one.
 * - A move under HEADING_MIN_MOVE_METERS keeps `heading`, so a parked car
 *   doesn't spin. The very first fix (no previous) takes the road's
 *   direction if it is on the route.
 *
 * `heading` is null until the car's direction is known; the result stays
 * null while it still isn't (first fix off the route, or parked since).
 */
export function carHeading(input: {
  previous: PathPoint | null;
  current: PathPoint;
  route?: readonly PathPoint[] | null;
  heading: number | null;
}): number | null {
  const { previous, current, route, heading } = input;
  const road = routeBearingAt(current, route);
  if (!previous) return road ?? heading;
  if (haversineDistanceMeters(previous, current) < HEADING_MIN_MOVE_METERS) return heading;
  const moving = bearingBetween(previous, current);
  if (road !== null && Math.abs(shortestTurn(moving, road)) <= 90) return road;
  return moving;
}

/**
 * The line drawn on a trip map: road routes between campus zones where they
 * have been precomputed (ZoneRoute, served by GET /zones/routes), straight
 * lines where they haven't. Pure, so both apps and the server draw and time
 * the same thing.
 */
import { haversineDistanceMeters, nearestZone } from "./distance";
import { decodePolyline, type PathPoint } from "./polyline";
import { ASSUMED_AVERAGE_SPEED_KMH, ROAD_CIRCUITY_FACTOR, estimateEtaMinutes } from "../eta/eta";

export interface RouteZone {
  id: string;
  latitude: number;
  longitude: number;
}

export interface StoredRoute {
  fromZoneId: string;
  toZoneId: string;
  polyline: string;
  durationSeconds: number;
}

export type RouteLookup = ReadonlyMap<string, StoredRoute>;

export function routeKey(fromZoneId: string, toZoneId: string): string {
  return `${fromZoneId}>${toZoneId}`;
}

export function indexRoutes(routes: readonly StoredRoute[]): RouteLookup {
  return new Map(routes.map((r) => [routeKey(r.fromZoneId, r.toZoneId), r]));
}

/** Zone-to-zone path: the stored road route, or a straight line when there is none. */
export function pathBetweenZones(from: RouteZone, to: RouteZone, routes: RouteLookup): PathPoint[] {
  const stored = routes.get(routeKey(from.id, to.id));
  const decoded = stored ? decodePolyline(stored.polyline) : [];
  if (decoded.length >= 2) return decoded;
  return [
    { latitude: from.latitude, longitude: from.longitude },
    { latitude: to.latitude, longitude: to.longitude },
  ];
}

/** Closest point to `p` on segment a–b (flat-earth maths; fine across a campus). */
function closestOnSegment(p: PathPoint, a: PathPoint, b: PathPoint): { point: PathPoint; t: number } {
  const kx = Math.cos((p.latitude * Math.PI) / 180);
  const ax = a.longitude * kx;
  const bx = b.longitude * kx;
  const px = p.longitude * kx;
  const dx = bx - ax;
  const dy = b.latitude - a.latitude;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (p.latitude - a.latitude) * dy) / len2));
  return {
    point: { latitude: a.latitude + dy * t, longitude: a.longitude + (b.longitude - a.longitude) * t },
    t,
  };
}

/** How far off a route the driver may be and still be "on" it. */
export const ON_ROUTE_METERS = 60;

/**
 * What's left of `path` from where the driver is: the part already driven
 * is cut off and the line starts at the driver's spot on it. If the driver
 * isn't near the path (more than ON_ROUTE_METERS away), the path is returned
 * whole, with the driver joined to its start.
 */
export function trimPathToPosition(path: readonly PathPoint[], position: PathPoint): PathPoint[] {
  if (path.length < 2) return [position, ...path];
  let best = { distance: Infinity, index: 0, point: path[0]! };
  for (let i = 1; i < path.length; i++) {
    const { point } = closestOnSegment(position, path[i - 1]!, path[i]!);
    const distance = haversineDistanceMeters(position, point);
    if (distance < best.distance) best = { distance, index: i, point };
  }
  if (best.distance > ON_ROUTE_METERS) return [position, ...path];
  return [position, best.point, ...path.slice(best.index)];
}

/**
 * The driver's way to a stop: the stored route from the zone the driver is
 * in, with the part already driven trimmed off; a straight line when the
 * driver is already in the stop's zone, or no route is stored.
 */
export function pathFromDriver(
  driver: PathPoint,
  stop: RouteZone,
  zones: readonly RouteZone[],
  routes: RouteLookup,
): PathPoint[] {
  const here = nearestZone(driver.latitude, driver.longitude, zones);
  if (!here || here.id === stop.id || !routes.has(routeKey(here.id, stop.id))) {
    return [driver, { latitude: stop.latitude, longitude: stop.longitude }];
  }
  return trimPathToPosition(pathBetweenZones(here, stop, routes), driver);
}

/** The whole remaining trip as one line: driver → stop 1 → stop 2 → … */
export function tripPath(
  driver: PathPoint | null,
  stops: readonly RouteZone[],
  zones: readonly RouteZone[],
  routes: RouteLookup,
): PathPoint[] {
  if (stops.length === 0) return [];
  const path: PathPoint[] = driver ? pathFromDriver(driver, stops[0]!, zones, routes) : [stops[0]!];
  for (let i = 1; i < stops.length; i++) {
    if (stops[i]!.id === stops[i - 1]!.id) continue;
    path.push(...pathBetweenZones(stops[i - 1]!, stops[i]!, routes).slice(1));
  }
  return path;
}

/**
 * Minutes to a stop: the stored route's driving time from the driver's zone
 * when there is one (plus the bit from the driver to their zone's centre),
 * otherwise the straight-line estimate. Null without a position.
 */
export function etaToStopMinutes(
  driver: PathPoint | null,
  stop: RouteZone,
  zones: readonly RouteZone[],
  routes: RouteLookup,
): number | null {
  if (!driver) return null;
  const here = nearestZone(driver.latitude, driver.longitude, zones);
  const stored = here && here.id !== stop.id ? routes.get(routeKey(here.id, stop.id)) : undefined;
  if (stored && here) {
    const toCentre = estimateEtaMinutes(driver, here) ?? 0;
    const nearCentre = haversineDistanceMeters(driver, here) < 150;
    return Math.max(1, Math.round(stored.durationSeconds / 60 + (nearCentre ? 0 : toCentre)));
  }
  return estimateEtaMinutes(driver, stop);
}

// ─── Driving time for a whole plan ───────────────────────────────────────────

/**
 * Time spent at each stop (pulling in, the rider getting in or out). Counted
 * per stop so that adding a rider costs two stops' worth even when both are
 * right on the existing route.
 */
export const STOP_DWELL_SECONDS = 45;

/** Straight-line driving time in seconds (the same model as estimateEtaMinutes, unrounded). */
export function straightLineSeconds(a: PathPoint, b: PathPoint): number {
  const metersPerSecond = (ASSUMED_AVERAGE_SPEED_KMH * 1000) / 3600;
  return (haversineDistanceMeters(a, b) * ROAD_CIRCUITY_FACTOR) / metersPerSecond;
}

/** Zone to zone: the stored route's time, or the straight-line estimate; 0 within a zone. */
export function legSeconds(from: RouteZone, to: RouteZone, routes: RouteLookup): number {
  if (from.id === to.id) return 0;
  return routes.get(routeKey(from.id, to.id))?.durationSeconds ?? straightLineSeconds(from, to);
}

/** From the driver's exact position to a stop. */
export function driverLegSeconds(
  driver: PathPoint,
  stop: RouteZone,
  zones: readonly RouteZone[],
  routes: RouteLookup,
): number {
  const here = nearestZone(driver.latitude, driver.longitude, zones);
  if (!here || here.id === stop.id) return straightLineSeconds(driver, stop);
  const stored = routes.get(routeKey(here.id, stop.id));
  if (!stored) return straightLineSeconds(driver, stop);
  return straightLineSeconds(driver, here) + stored.durationSeconds;
}

/**
 * Seconds to drive a whole plan: from `from` (the driver, or the first stop
 * when unknown) through every stop in order, plus STOP_DWELL_SECONDS per stop.
 */
export function planSeconds(
  from: PathPoint | null,
  stops: readonly RouteZone[],
  zones: readonly RouteZone[],
  routes: RouteLookup,
): number {
  if (stops.length === 0) return 0;
  let total = from ? driverLegSeconds(from, stops[0]!, zones, routes) : 0;
  for (let i = 1; i < stops.length; i++) total += legSeconds(stops[i - 1]!, stops[i]!, routes);
  return total + stops.length * STOP_DWELL_SECONDS;
}

/**
 * The credit a map must show when it draws a stored road route. Both
 * providers use OpenStreetMap data (ODbL); OSRM's demo server also asks to be
 * named as the source of the routes.
 */
export function routeAttribution(provider: string | null | undefined): string {
  if (provider === "osrm") return "Routes: OSRM · © OpenStreetMap contributors";
  if (provider === "ors") return "Routes: openrouteservice · © OpenStreetMap contributors";
  return "© OpenStreetMap contributors";
}

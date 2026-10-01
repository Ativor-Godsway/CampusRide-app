/**
 * The line drawn on a trip map: road routes between campus zones where they
 * have been precomputed (ZoneRoute, served by GET /zones/routes), straight
 * lines where they haven't. Pure, so both apps draw the same thing.
 */
import { haversineDistanceMeters, nearestZone } from "./distance";
import { decodePolyline, type PathPoint } from "./polyline";
import { estimateEtaMinutes } from "../eta/eta";

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

/**
 * The driver's way to a stop. Uses the stored route from the zone the driver
 * is in, joined to the driver's exact position; a straight line when the
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
  return [driver, ...pathBetweenZones(here, stop, routes)];
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

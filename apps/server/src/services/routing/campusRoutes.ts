/**
 * Road routes through exact points — a trip's pins, or the driver and the
 * stops ahead — on CampusRide's own campus road graph (CampusRouter in
 * @rida/shared, data in assets/map/campus-roads.json; docs/routing.md).
 *
 * Since 2026-10-29 this replaces the public OSRM server: routes never leave
 * the service area, never use J.J. Rawlings Avenue or another trunk road,
 * and never pass a closed gate, because the graph has none of them. Each
 * point is snapped to the nearest drivable campus road. A route is computed
 * here in a few milliseconds, so there is no rate limit, no network call and
 * no database cache (the PointRoute table is no longer read or written);
 * recent answers are kept in memory.
 */
import {
  CampusRouter,
  encodePolyline,
  isCampusRouteError,
  type CampusRoadData,
  type CampusRouteError,
  type PathPoint,
} from "@rida/shared";
import campusRoads from "../../../../../assets/map/campus-roads.json";

export const MAX_ROUTE_POINTS = 10;

/**
 * What the apps read as "a real road" (they draw it solid, with its credit).
 * Named for the router used before 2026-10-29; kept so apps already
 * installed draw these routes as roads.
 */
export const ROAD_SOURCE = "osrm" as const;

/** Provider recorded on ZoneRoute rows the campus engine made. */
export const CAMPUS_PROVIDER = "campus";

export interface RouteLegSummary {
  distanceMeters: number;
  durationSeconds: number;
}

export interface PointRoute {
  /** The whole line, first snapped point to last: Google encoded polyline, precision 5. */
  polyline: string;
  distanceMeters: number;
  durationSeconds: number;
  /** Leg i is points[i] → points[i + 1]. */
  legs: RouteLegSummary[];
  source: typeof ROAD_SOURCE;
}

let router: CampusRouter | null = null;

/** The campus router, built once (a few milliseconds) from the graph file. */
export function campusRouter(): CampusRouter {
  router ??= new CampusRouter(campusRoads as unknown as CampusRoadData);
  return router;
}

const MEMORY_MAX = 1_000;
const memory = new Map<string, PointRoute | CampusRouteError>();

/** Points rounded to 5 decimals (~1 m): the same pins asked twice are one computation. */
export function pointRouteKey(points: readonly PathPoint[]): string {
  return points.map((p) => `${p.latitude.toFixed(5)},${p.longitude.toFixed(5)}`).join(">");
}

/** The route through `points` (2 to MAX_ROUTE_POINTS), or why there is none. */
export function routeThroughPoints(points: readonly PathPoint[]): PointRoute | CampusRouteError {
  const key = pointRouteKey(points);
  const kept = memory.get(key);
  if (kept) {
    memory.delete(key);
    memory.set(key, kept);
    return kept;
  }
  const r = campusRouter().route(points);
  const answer: PointRoute | CampusRouteError = isCampusRouteError(r)
    ? r
    : {
        polyline: encodePolyline(r.path),
        distanceMeters: r.distanceMeters,
        durationSeconds: r.durationSeconds,
        legs: r.legs,
        source: ROAD_SOURCE,
      };
  memory.set(key, answer);
  if (memory.size > MEMORY_MAX) memory.delete(memory.keys().next().value!);
  return answer;
}

/** The route, or null when there is none (numbers shown on a ride offer). */
export function estimateRoute(points: readonly PathPoint[]): PointRoute | null {
  const r = routeThroughPoints(points);
  return "code" in r ? null : r;
}

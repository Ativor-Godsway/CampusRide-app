/**
 * Road routes through exact points — what a trip map draws from a pickup pin
 * to a drop-off pin, or from the driver through the stops ahead.
 *
 * ONE OSRM request per set of points (OSRM routes through waypoints and
 * reports each leg), kept in memory and in the PointRoute table so a restart
 * or a second screen doesn't ask again. Points are rounded to 4 decimals
 * (~11 m) for the key, so the same places picked twice are one request.
 *
 * To respect OSRM's demo-server policy ("no heavy use", about 1 request a
 * second) this server never calls it more than once per
 * config.routing.minIntervalMs. A request that would come sooner, times out
 * (config.routing.timeoutMs) or fails gets the FALLBACK straight away — the
 * stored zone-to-zone roads with their ends moved to the pins — and is not
 * cached, so the next request for those points tries OSRM again.
 *
 * How busy we are: every OSRM call is logged with the day's running count,
 * and past config.routing.dailyWarnAt in a day each further call is a
 * warning. docs/routing.md says when to move to a self-hosted OSRM.
 */
import type { PrismaClient } from "@prisma/client";
import {
  encodePolyline,
  haversineDistanceMeters,
  indexRoutes,
  legSeconds,
  nearestZone,
  pathBetweenStops,
  pathLengthMeters,
  straightLineSeconds,
  type PathPoint,
} from "@rida/shared";
import { config } from "../../config";
import { logger } from "../../lib/logger";
import { getActiveZones, getStoredZoneRoutes } from "../zones/zoneCache";

export interface RouteLegSummary {
  distanceMeters: number;
  durationSeconds: number;
}

export interface PointRoute {
  /** The whole line, first point to last: Google encoded polyline, precision 5. */
  polyline: string;
  distanceMeters: number;
  durationSeconds: number;
  /** Leg i is points[i] → points[i + 1]. */
  legs: RouteLegSummary[];
  /** "osrm": real roads through the points. "zones": the fallback (stored zone roads, pins at the ends). */
  source: "osrm" | "zones";
}

export type RouteFetcher = (points: readonly PathPoint[]) => Promise<Omit<PointRoute, "source"> | null>;

export const MAX_ROUTE_POINTS = 10;

const USER_AGENT = "CampusRide/1.0 (campus ride-hailing; per-trip routes, cached)";

/** Pulls the route and its legs out of an OSRM /route/v1 response (geometries=polyline). */
export function parseOsrmRoute(body: unknown): Omit<PointRoute, "source"> | null {
  const route = (
    body as {
      routes?: Array<{
        geometry?: unknown;
        distance?: number;
        duration?: number;
        legs?: Array<{ distance?: number; duration?: number }>;
      }>;
    }
  )?.routes?.[0];
  if (!route || typeof route.geometry !== "string") return null;
  return {
    polyline: route.geometry,
    distanceMeters: Math.round(route.distance ?? 0),
    durationSeconds: Math.round(route.duration ?? 0),
    legs: (route.legs ?? []).map((l) => ({
      distanceMeters: Math.round(l.distance ?? 0),
      durationSeconds: Math.round(l.duration ?? 0),
    })),
  };
}

const osrmFetch: RouteFetcher = async (points) => {
  const base = config.routing.osrmBaseUrl.replace(/\/+$/, "");
  const coords = points.map((p) => `${p.longitude.toFixed(6)},${p.latitude.toFixed(6)}`).join(";");
  const res = await fetch(`${base}/route/v1/driving/${coords}?overview=full&geometries=polyline`, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(config.routing.timeoutMs),
  });
  if (!res.ok) throw new Error(`OSRM answered HTTP ${res.status}`);
  return parseOsrmRoute(await res.json());
};

let testFetcher: RouteFetcher | null = null;
let lastCallAt = 0;
let dayKey = "";
const today = { calls: 0, fallbacks: 0 };

const MEMORY_MAX = 1_000;
const memory = new Map<string, PointRoute>();

/** Tests: send OSRM calls to `f` (no minimum interval); null restores the default. Clears the memory cache. */
export function setRouteFetcherForTests(f: RouteFetcher | null): void {
  testFetcher = f;
  lastCallAt = 0;
  memory.clear();
}

function remember(key: string, route: PointRoute): void {
  memory.delete(key);
  memory.set(key, route);
  if (memory.size > MEMORY_MAX) memory.delete(memory.keys().next().value!);
}

export function pointRouteKey(points: readonly PathPoint[]): string {
  return points.map((p) => `${p.latitude.toFixed(4)},${p.longitude.toFixed(4)}`).join(">");
}

function count(kind: "calls" | "fallbacks"): number {
  const day = new Date().toISOString().slice(0, 10);
  if (day !== dayKey) {
    dayKey = day;
    today.calls = 0;
    today.fallbacks = 0;
  }
  today[kind] += 1;
  return today[kind];
}

/** The instant fallback, leg by leg: stored zone roads with the ends moved to the points. */
export async function fallbackRoute(prisma: PrismaClient, points: readonly PathPoint[]): Promise<PointRoute> {
  const [zones, stored] = await Promise.all([getActiveZones(prisma), getStoredZoneRoutes(prisma)]);
  const routes = indexRoutes(stored);
  const path: PathPoint[] = [points[0]!];
  const legs: RouteLegSummary[] = [];
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1]!;
    const to = points[i]!;
    const a = nearestZone(from.latitude, from.longitude, zones);
    const b = nearestZone(to.latitude, to.longitude, zones);
    const legPath = a && b ? pathBetweenStops({ ...a, point: from }, { ...b, point: to }, routes) : [from, to];
    const seconds =
      a && b && a.id !== b.id
        ? straightLineSeconds(from, a) + legSeconds(a, b, routes) + straightLineSeconds(b, to)
        : straightLineSeconds(from, to);
    legs.push({
      distanceMeters: Math.round(legPath.length >= 2 ? pathLengthMeters(legPath) : haversineDistanceMeters(from, to)),
      durationSeconds: Math.round(seconds),
    });
    path.push(...legPath.slice(1));
  }
  return {
    polyline: encodePolyline(path),
    distanceMeters: legs.reduce((sum, l) => sum + l.distanceMeters, 0),
    durationSeconds: legs.reduce((sum, l) => sum + l.durationSeconds, 0),
    legs,
    source: "zones",
  };
}

/** The route through `points` (2 to MAX_ROUTE_POINTS): memory, then the table, then OSRM if allowed now, else the fallback. */
export async function routeThroughPoints(prisma: PrismaClient, points: readonly PathPoint[]): Promise<PointRoute> {
  const key = pointRouteKey(points);
  const inMemory = memory.get(key);
  if (inMemory) return inMemory;

  const stored = await prisma.pointRoute.findUnique({ where: { key } });
  if (stored) {
    const route: PointRoute = {
      polyline: stored.polyline,
      distanceMeters: stored.distanceMeters,
      durationSeconds: stored.durationSeconds,
      legs: stored.legDurations.map((durationSeconds, i) => ({
        durationSeconds,
        distanceMeters: stored.legDistances[i] ?? 0,
      })),
      source: "osrm",
    };
    remember(key, route);
    return route;
  }

  const live = testFetcher ?? (config.routing.disabled ? null : osrmFetch);
  const minInterval = testFetcher ? 0 : config.routing.minIntervalMs;
  const now = Date.now();
  if (live && now - lastCallAt >= minInterval) {
    lastCallAt = now;
    const calls = count("calls");
    logger[calls > config.routing.dailyWarnAt ? "warn" : "info"]("osrm route request", {
      event: "osrm_call",
      callsToday: calls,
      points: points.length,
    });
    try {
      const fetched = await live(points);
      if (fetched && fetched.legs.length === points.length - 1) {
        const route: PointRoute = { ...fetched, source: "osrm" };
        remember(key, route);
        await prisma.pointRoute
          .createMany({
            data: [
              {
                key,
                polyline: fetched.polyline,
                distanceMeters: fetched.distanceMeters,
                durationSeconds: fetched.durationSeconds,
                legDistances: fetched.legs.map((l) => l.distanceMeters),
                legDurations: fetched.legs.map((l) => l.durationSeconds),
                provider: "osrm",
              },
            ],
            skipDuplicates: true,
          })
          .catch((err) => logger.warn("point route not cached", { err }));
        return route;
      }
    } catch (err) {
      logger.warn("osrm route failed; drawing the zone route", { event: "osrm_failed", err });
    }
  }
  if (live) logger.info("point route fallback", { event: "osrm_fallback", fallbacksToday: count("fallbacks") });
  return fallbackRoute(prisma, points);
}

/**
 * A route estimate that never waits: OSRM's answer if this server already
 * has it in memory, else the zone-road fallback. For numbers shown on a ride
 * offer ("Trip 6 min · 2.3 km"), where a slow OSRM call must not hold up the
 * offer list.
 */
export async function estimateRoute(prisma: PrismaClient, points: readonly PathPoint[]): Promise<PointRoute> {
  return memory.get(pointRouteKey(points)) ?? fallbackRoute(prisma, points);
}

/**
 * Road routes between campus zones, fetched once from a routing service and
 * stored in ZoneRoute (see precomputeZoneRoutes.ts for the command and
 * docs/routing.md for the provider choice). Split from the command so the
 * provider parsing and the loop are testable without the network.
 */
import type { PrismaClient } from "@prisma/client";

export type RoutingProvider = "osrm" | "ors";

export interface FetchedRoute {
  polyline: string;
  distanceMeters: number;
  durationSeconds: number;
}

export interface LngLat {
  latitude: number;
  longitude: number;
}

export const PROVIDER_DEFAULTS: Record<RoutingProvider, { baseUrl: string; minIntervalMs: number }> = {
  // OSRM's public demo server: no key, "no heavy use" — one request a second.
  osrm: { baseUrl: "https://router.project-osrm.org", minIntervalMs: 1_100 },
  // openrouteservice free plan: 40 directions a minute.
  ors: { baseUrl: "https://api.openrouteservice.org", minIntervalMs: 1_600 },
};

const USER_AGENT = "CampusRide-zone-route-precompute/1.0 (one-off, about 210 requests)";

/** Pulls the route out of an OSRM /route/v1 response (geometries=polyline). */
export function parseOsrm(body: unknown): FetchedRoute | null {
  const route = (body as { code?: string; routes?: Array<{ geometry?: unknown; distance?: number; duration?: number }> })
    ?.routes?.[0];
  if (!route || typeof route.geometry !== "string") return null;
  return {
    polyline: route.geometry,
    distanceMeters: Math.round(route.distance ?? 0),
    durationSeconds: Math.round(route.duration ?? 0),
  };
}

/** Pulls the route out of an openrouteservice /v2/directions/{profile}/json response. */
export function parseOrs(body: unknown): FetchedRoute | null {
  const route = (body as { routes?: Array<{ geometry?: unknown; summary?: { distance?: number; duration?: number } }> })
    ?.routes?.[0];
  if (!route || typeof route.geometry !== "string") return null;
  return {
    polyline: route.geometry,
    distanceMeters: Math.round(route.summary?.distance ?? 0),
    durationSeconds: Math.round(route.summary?.duration ?? 0),
  };
}

export class RoutingHttpError extends Error {
  constructor(readonly status: number, detail: string) {
    super(`routing service answered HTTP ${status}: ${detail.slice(0, 200)}`);
  }
}

/** One driving route from `from` to `to` with the chosen provider. */
export async function fetchRoute(
  provider: RoutingProvider,
  from: LngLat,
  to: LngLat,
  options: { baseUrl?: string; apiKey?: string } = {},
): Promise<FetchedRoute | null> {
  const baseUrl = (options.baseUrl ?? PROVIDER_DEFAULTS[provider].baseUrl).replace(/\/+$/, "");
  let res: Response;
  if (provider === "osrm") {
    const coords = `${from.longitude},${from.latitude};${to.longitude},${to.latitude}`;
    res = await fetch(`${baseUrl}/route/v1/driving/${coords}?overview=full&geometries=polyline`, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(30_000),
    });
  } else {
    if (!options.apiKey) throw new Error("openrouteservice needs an API key: set ORS_API_KEY");
    res = await fetch(`${baseUrl}/v2/directions/driving-car/json`, {
      method: "POST",
      headers: { Authorization: options.apiKey, "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify({
        coordinates: [
          [from.longitude, from.latitude],
          [to.longitude, to.latitude],
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });
  }
  const text = await res.text();
  if (!res.ok) throw new RoutingHttpError(res.status, text);
  const body = JSON.parse(text) as unknown;
  return provider === "osrm" ? parseOsrm(body) : parseOrs(body);
}

export interface PrecomputeOptions {
  provider: RoutingProvider;
  /** Skip pairs that already have a route. */
  onlyMissing: boolean;
  /** Stop after this many fetches (for a trial run). */
  limit?: number;
  /** Fetch one route. Injected so tests never touch the network. */
  fetchOne: (from: LngLat, to: LngLat) => Promise<FetchedRoute | null>;
  /** Pause between fetches, ms. */
  minIntervalMs: number;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface PrecomputeReport {
  pairs: number;
  saved: number;
  skipped: number;
  failed: Array<{ from: string; to: string; error: string }>;
}

/**
 * Fetches and stores a route for every ordered pair of distinct zones (A→B
 * and B→A separately: one-way roads make them differ). Retries a failed pair
 * up to three times with growing pauses; a pair that still fails is reported
 * and left without a route (the apps draw a straight line for it).
 */
export async function precomputeZoneRoutes(prisma: PrismaClient, opts: PrecomputeOptions): Promise<PrecomputeReport> {
  const log = opts.log ?? (() => {});
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const zones = await prisma.zone.findMany({ orderBy: { name: "asc" } });
  const existing = opts.onlyMissing
    ? new Set(
        (await prisma.zoneRoute.findMany({ select: { fromZoneId: true, toZoneId: true } })).map(
          (r) => `${r.fromZoneId}>${r.toZoneId}`,
        ),
      )
    : new Set<string>();

  const report: PrecomputeReport = { pairs: 0, saved: 0, skipped: 0, failed: [] };
  let fetches = 0;

  for (const from of zones) {
    for (const to of zones) {
      if (from.id === to.id) continue;
      report.pairs += 1;
      if (existing.has(`${from.id}>${to.id}`)) {
        report.skipped += 1;
        continue;
      }
      if (opts.limit !== undefined && fetches >= opts.limit) {
        report.skipped += 1;
        continue;
      }

      let route: FetchedRoute | null = null;
      let lastError = "no route returned";
      for (let attempt = 0; attempt < 4 && !route; attempt++) {
        if (fetches > 0 || attempt > 0) await sleep(opts.minIntervalMs * (attempt === 0 ? 1 : 2 ** attempt));
        fetches += attempt === 0 ? 1 : 0;
        try {
          route = await opts.fetchOne(from, to);
          if (!route) lastError = "no route returned";
        } catch (err) {
          lastError = (err as Error).message;
          if (err instanceof RoutingHttpError && err.status >= 400 && err.status < 500 && err.status !== 429) break;
        }
      }

      if (!route) {
        report.failed.push({ from: from.name, to: to.name, error: lastError });
        log(`  ✗ ${from.name} → ${to.name}: ${lastError}`);
        continue;
      }

      await prisma.zoneRoute.upsert({
        where: { fromZoneId_toZoneId: { fromZoneId: from.id, toZoneId: to.id } },
        update: { ...route, provider: opts.provider },
        create: { fromZoneId: from.id, toZoneId: to.id, ...route, provider: opts.provider },
      });
      report.saved += 1;
      log(
        `  ✓ ${from.name} → ${to.name}  ${(route.distanceMeters / 1000).toFixed(1)} km, ` +
          `${Math.round(route.durationSeconds / 60)} min`,
      );
    }
  }
  return report;
}

/**
 * Road routes between campus zones, stored in ZoneRoute: what the detour
 * rule and the driver's trip planning use for zone-to-zone drive times, and
 * what apps draw when they have nothing better. Since 2026-10-29 they come
 * from CampusRide's own campus route engine (services/routing/campusRoutes),
 * so, like every route, they stay on campus roads. The command is
 * precomputeZoneRoutes.ts; docs/routing.md says when to run it.
 */
import type { PrismaClient } from "@prisma/client";
import { CAMPUS_PROVIDER, estimateRoute } from "../services/routing/campusRoutes";
import { SCRIPT_TX_OPTIONS } from "./scriptTx";

export interface ZoneRouteData {
  polyline: string;
  distanceMeters: number;
  durationSeconds: number;
}

export interface LngLat {
  latitude: number;
  longitude: number;
}

/** One zone-to-zone route on campus roads, or null when there is none. */
export function campusZoneRoute(from: LngLat, to: LngLat): ZoneRouteData | null {
  const r = estimateRoute([from, to]);
  return r ? { polyline: r.polyline, distanceMeters: r.distanceMeters, durationSeconds: r.durationSeconds } : null;
}

export interface PrecomputeOptions {
  /** False (the default in the command): work everything out, write nothing. */
  apply: boolean;
  /** The route for one pair; injected by tests. */
  routeOne?: (from: LngLat, to: LngLat) => ZoneRouteData | null;
  log?: (line: string) => void;
}

export interface PrecomputeReport {
  pairs: number;
  /** Pairs given a campus route (written with --apply). */
  routed: number;
  /** Pairs with no campus route; any stored route for them is removed with --apply. */
  failed: Array<{ from: string; to: string }>;
  /** Stored routes before, by provider ("osrm", "campus"…). */
  before: Record<string, number>;
  applied: boolean;
}

/**
 * A campus route for every ordered pair of zones in service (A→B and B→A
 * apart: one-way roads make them differ). All written in one transaction
 * with `apply`; a pair with no campus route loses any old (OSRM) route, so
 * nothing off campus is left behind (the apps draw a straight line for it).
 */
export async function precomputeZoneRoutes(prisma: PrismaClient, opts: PrecomputeOptions): Promise<PrecomputeReport> {
  const log = opts.log ?? (() => {});
  const routeOne = opts.routeOne ?? campusZoneRoute;
  // Zones in service only: no route to or from a retired zone.
  const zones = await prisma.zone.findMany({ where: { retiredAt: null }, orderBy: { name: "asc" } });
  const stored = await prisma.zoneRoute.findMany({ select: { provider: true } });
  const before: Record<string, number> = {};
  for (const { provider } of stored) before[provider] = (before[provider] ?? 0) + 1;

  const report: PrecomputeReport = { pairs: 0, routed: 0, failed: [], before, applied: opts.apply };
  const writes: Array<{ from: string; to: string; route: ZoneRouteData | null }> = [];
  for (const from of zones) {
    for (const to of zones) {
      if (from.id === to.id) continue;
      report.pairs += 1;
      const route = routeOne(from, to);
      writes.push({ from: from.id, to: to.id, route });
      if (route) {
        report.routed += 1;
        log(`  ✓ ${from.name} → ${to.name}  ${(route.distanceMeters / 1000).toFixed(1)} km, ${Math.round(route.durationSeconds / 60)} min`);
      } else {
        report.failed.push({ from: from.name, to: to.name });
        log(`  ✗ ${from.name} → ${to.name}: no campus route`);
      }
    }
  }

  if (opts.apply) {
    await prisma.$transaction(async (tx) => {
      for (const { from, to, route } of writes) {
        const where = { fromZoneId_toZoneId: { fromZoneId: from, toZoneId: to } };
        if (route) {
          await tx.zoneRoute.upsert({
            where,
            update: { ...route, provider: CAMPUS_PROVIDER },
            create: { fromZoneId: from, toZoneId: to, ...route, provider: CAMPUS_PROVIDER },
          });
        } else {
          await tx.zoneRoute.deleteMany({ where: { fromZoneId: from, toZoneId: to } });
        }
      }
    }, SCRIPT_TX_OPTIONS);
  }
  return report;
}

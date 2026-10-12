import type { PrismaClient, Zone, ZoneAdjacency, ZoneRoute } from "@prisma/client";
import { nearestZone } from "@rida/shared";

/**
 * Zones (15 campus spots) and their adjacency (≤ 210 edges) are seeded and
 * never change while the server runs, but driver endpoints used to re-read
 * them on every request — one or two extra database round trips each, which
 * adds up fast when the database is far away (see
 * routes/driverRoundTrips.test.ts). They are cached here instead.
 *
 * A short TTL, not forever: a zone added by hand (seed, admin) shows up
 * within a minute without a restart.
 */
const TTL_MS = 60_000;

interface Snapshot {
  at: number;
  zones: Map<string, Zone>;
  adjacency: ZoneAdjacency[];
  routes: ZoneRoute[];
}

const snapshots = new WeakMap<PrismaClient, Snapshot>();
/** Clients the test suite has opted in (see forceZoneCacheForTests). */
const forced = new WeakSet<PrismaClient>();

/**
 * The suite creates and deletes adjacency edges per test and expects them to
 * be seen at once, so under NODE_ENV=test the cache is bypassed unless a test
 * opts a client in (the round-trip budget test does, to measure what a
 * running server does). The place cache (services/places/placeCache.ts)
 * follows the same switch.
 */
export function cacheEnabled(prisma: PrismaClient): boolean {
  return process.env.NODE_ENV !== "test" || forced.has(prisma);
}

export function forceZoneCacheForTests(prisma: PrismaClient): void {
  forced.add(prisma);
}
const inFlight = new WeakMap<PrismaClient, Promise<Snapshot>>();

async function load(prisma: PrismaClient): Promise<Snapshot> {
  const [zones, adjacency, routes] = await Promise.all([
    prisma.zone.findMany(),
    prisma.zoneAdjacency.findMany(),
    prisma.zoneRoute.findMany(),
  ]);
  return { at: Date.now(), zones: new Map(zones.map((z) => [z.id, z])), adjacency, routes };
}

async function snapshot(prisma: PrismaClient): Promise<Snapshot> {
  if (!cacheEnabled(prisma)) return load(prisma);
  const cached = snapshots.get(prisma);
  if (cached && Date.now() - cached.at < TTL_MS) return cached;
  let pending = inFlight.get(prisma);
  if (!pending) {
    pending = load(prisma).finally(() => inFlight.delete(prisma));
    inFlight.set(prisma, pending);
  }
  const fresh = await pending;
  snapshots.set(prisma, fresh);
  return fresh;
}

/**
 * Every zone, by id — RETIRED ones too, because old rides reference them
 * and must still show their names. For anything new (deriving a zone from a
 * pin, a driver's zone, a place's zone) use getActiveZones.
 */
export async function getZoneMap(prisma: PrismaClient): Promise<Map<string, Zone>> {
  return (await snapshot(prisma)).zones;
}

/** The zones in service (retiredAt null): the only ones anything new may use. */
export async function getActiveZones(prisma: PrismaClient): Promise<Zone[]> {
  return [...(await snapshot(prisma)).zones.values()].filter((z) => z.retiredAt === null);
}

/**
 * The zone a driver who reports `zoneId` is counted in: that zone if it is
 * in service, else the in-service zone nearest its centre (an app holding a
 * zone list from before a zone was retired keeps sending it). Null for an
 * unknown id.
 */
export async function servedZoneId(prisma: PrismaClient, zoneId: string): Promise<string | null> {
  const zone = (await getZoneMap(prisma)).get(zoneId);
  if (!zone) return null;
  if (zone.retiredAt === null) return zone.id;
  return nearestZone(zone.latitude, zone.longitude, await getActiveZones(prisma))?.id ?? null;
}

/**
 * Every adjacency edge between two zones in service (read in both
 * directions by callers). Edges touching a retired zone are left out, so
 * driver eligibility never flows through one.
 */
export async function getZoneAdjacency(prisma: PrismaClient): Promise<ZoneAdjacency[]> {
  const { zones, adjacency } = await snapshot(prisma);
  const active = (id: string) => zones.get(id)?.retiredAt === null;
  return adjacency.filter((e) => active(e.zoneId) && active(e.adjacentZoneId));
}

/** Drops the cache — for tests that create or delete zones/edges. */
export function clearZoneCache(prisma: PrismaClient): void {
  snapshots.delete(prisma);
}

/** Every stored zone-to-zone road route (precomputeZoneRoutes.ts); empty until precomputed. */
export async function getStoredZoneRoutes(prisma: PrismaClient): Promise<ZoneRoute[]> {
  return (await snapshot(prisma)).routes;
}

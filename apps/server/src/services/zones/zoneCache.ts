import type { PrismaClient, Zone, ZoneAdjacency } from "@prisma/client";

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
}

const snapshots = new WeakMap<PrismaClient, Snapshot>();
/** Clients the test suite has opted in (see forceZoneCacheForTests). */
const forced = new WeakSet<PrismaClient>();

/**
 * The suite creates and deletes adjacency edges per test and expects them to
 * be seen at once, so under NODE_ENV=test the cache is bypassed unless a test
 * opts a client in (the round-trip budget test does, to measure what a
 * running server does).
 */
function cacheEnabled(prisma: PrismaClient): boolean {
  return process.env.NODE_ENV !== "test" || forced.has(prisma);
}

export function forceZoneCacheForTests(prisma: PrismaClient): void {
  forced.add(prisma);
}
const inFlight = new WeakMap<PrismaClient, Promise<Snapshot>>();

async function load(prisma: PrismaClient): Promise<Snapshot> {
  const [zones, adjacency] = await Promise.all([
    prisma.zone.findMany(),
    prisma.zoneAdjacency.findMany(),
  ]);
  return { at: Date.now(), zones: new Map(zones.map((z) => [z.id, z])), adjacency };
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

/** Every zone, by id. */
export async function getZoneMap(prisma: PrismaClient): Promise<Map<string, Zone>> {
  return (await snapshot(prisma)).zones;
}

/** Every adjacency edge (read in both directions by callers). */
export async function getZoneAdjacency(prisma: PrismaClient): Promise<ZoneAdjacency[]> {
  return (await snapshot(prisma)).adjacency;
}

/** Drops the cache — for tests that create or delete zones/edges. */
export function clearZoneCache(prisma: PrismaClient): void {
  snapshots.delete(prisma);
}

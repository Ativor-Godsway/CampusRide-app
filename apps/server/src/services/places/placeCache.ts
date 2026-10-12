import type { Place, PrismaClient } from "@prisma/client";
import { cacheEnabled } from "../zones/zoneCache";

/**
 * The active campus places (a couple of hundred rows), cached like the zones
 * (services/zones/zoneCache.ts): every ride booking labels its pins from
 * them, and a search would otherwise read the whole table each keystroke.
 * Admin edits call clearPlaceCache, so a change shows at once on this
 * instance and within a minute anywhere else.
 */
const TTL_MS = 60_000;

const snapshots = new WeakMap<PrismaClient, { at: number; places: Place[] }>();
const inFlight = new WeakMap<PrismaClient, Promise<Place[]>>();

export async function getActivePlaces(prisma: PrismaClient): Promise<Place[]> {
  const load = () => prisma.place.findMany({ where: { isActive: true }, orderBy: { name: "asc" } });
  // Off under NODE_ENV=test (tests add places and expect to see them at
  // once) unless a test opts in, exactly like the zone cache.
  if (!cacheEnabled(prisma)) return load();
  const cached = snapshots.get(prisma);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.places;
  let pending = inFlight.get(prisma);
  if (!pending) {
    pending = load().finally(() => inFlight.delete(prisma));
    inFlight.set(prisma, pending);
  }
  const places = await pending;
  snapshots.set(prisma, { at: Date.now(), places });
  return places;
}

export function clearPlaceCache(prisma: PrismaClient): void {
  snapshots.delete(prisma);
}

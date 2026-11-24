import type { Prisma, PrismaClient } from "@prisma/client";
import { computeZoneNeighbours, zonePairKey, type ZoneNeighbourPair } from "@rida/shared";
import { clearZoneCache } from "./zoneCache";

/**
 * Zone neighbours (ZoneAdjacency) as pairs (2026-11-24). Dispatch offers a
 * request to drivers in its pickup zone and the zones next to it, read from
 * ZoneAdjacency in either direction; each pair is stored both ways.
 *
 * - suggestedZoneNeighbours: worked out from where the zones are
 *   (@rida/shared geo/zoneNeighbours: cells that share a border, or centres
 *   within 800 m).
 * - currentZoneNeighbours: what dispatch uses now.
 * - replaceZoneNeighbours: makes the stored pairs exactly these (admin site,
 *   Places → Zone neighbours; prisma/seed.ts; npm run zones:link). Only
 *   pairs between zones in service are touched: rows with a retired zone are
 *   already ignored everywhere and stay as history.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export interface ZonePair {
  a: string;
  b: string;
}

let suggestionCache: { key: string; pairs: ZoneNeighbourPair[] } | null = null;

async function activeZones(db: Db) {
  return db.zone.findMany({
    where: { retiredAt: null },
    select: { id: true, name: true, latitude: true, longitude: true },
    orderBy: { name: "asc" },
  });
}

/** The suggested pairs for the zones in service (cached while the zones don't move). */
export async function suggestedZoneNeighbours(db: Db): Promise<ZoneNeighbourPair[]> {
  const zones = await activeZones(db);
  const key = zones.map((z) => `${z.id}@${z.latitude},${z.longitude}`).join(";");
  if (suggestionCache?.key === key) return suggestionCache.pairs;
  const pairs = computeZoneNeighbours(zones);
  suggestionCache = { key, pairs };
  return pairs;
}

/** The pairs stored now between zones in service, each once (a < b). */
export async function currentZoneNeighbours(db: Db): Promise<ZonePair[]> {
  const zones = await activeZones(db);
  const ids = zones.map((z) => z.id);
  const rows = await db.zoneAdjacency.findMany({
    where: { zoneId: { in: ids }, adjacentZoneId: { in: ids } },
    select: { zoneId: true, adjacentZoneId: true },
  });
  const pairs = new Map<string, ZonePair>();
  for (const r of rows) {
    if (r.zoneId === r.adjacentZoneId) continue;
    const [a, b] = r.zoneId < r.adjacentZoneId ? [r.zoneId, r.adjacentZoneId] : [r.adjacentZoneId, r.zoneId];
    pairs.set(zonePairKey(a, b), { a, b });
  }
  return [...pairs.values()].sort((x, y) => zonePairKey(x.a, x.b).localeCompare(zonePairKey(y.a, y.b)));
}

export class ZoneNeighbourError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZoneNeighbourError";
  }
}

/**
 * Makes the stored neighbours between zones in service exactly `pairs`
 * (both directions), in one transaction. Refuses an unknown or retired zone,
 * a zone paired with itself, and a zone left with no neighbour at all (its
 * requests would only ever reach drivers inside it). Returns what changed.
 */
export async function replaceZoneNeighbours(
  prisma: PrismaClient,
  pairs: readonly ZonePair[],
  opts: { adminId?: string | null } = {},
): Promise<{ added: ZonePair[]; removed: ZonePair[] }> {
  const result = await prisma.$transaction(async (tx) => {
    const zones = await activeZones(tx);
    const byId = new Map(zones.map((z) => [z.id, z]));
    const wanted = new Map<string, ZonePair>();
    for (const p of pairs) {
      if (!byId.has(p.a) || !byId.has(p.b)) throw new ZoneNeighbourError("Every zone must be a zone in service.");
      if (p.a === p.b) throw new ZoneNeighbourError("A zone can't be its own neighbour.");
      const [a, b] = p.a < p.b ? [p.a, p.b] : [p.b, p.a];
      wanted.set(zonePairKey(a, b), { a, b });
    }
    const lonely = zones.filter((z) => ![...wanted.values()].some((p) => p.a === z.id || p.b === z.id));
    if (zones.length > 1 && lonely.length > 0) {
      throw new ZoneNeighbourError(`Every zone needs at least one neighbour: ${lonely.map((z) => z.name).join(", ")} has none.`);
    }

    const current = await currentZoneNeighbours(tx);
    const currentKeys = new Set(current.map((p) => zonePairKey(p.a, p.b)));
    const removed = current.filter((p) => !wanted.has(zonePairKey(p.a, p.b)));
    const added = [...wanted.values()].filter((p) => !currentKeys.has(zonePairKey(p.a, p.b)));

    for (const p of removed) {
      await tx.zoneAdjacency.deleteMany({
        where: { OR: [{ zoneId: p.a, adjacentZoneId: p.b }, { zoneId: p.b, adjacentZoneId: p.a }] },
      });
    }
    // Both directions for every wanted pair (one may be missing even where the pair "exists").
    await tx.zoneAdjacency.createMany({
      data: [...wanted.values()].flatMap((p) => [
        { zoneId: p.a, adjacentZoneId: p.b },
        { zoneId: p.b, adjacentZoneId: p.a },
      ]),
      skipDuplicates: true,
    });

    if (opts.adminId && (added.length || removed.length)) {
      const name = (p: ZonePair) => `${byId.get(p.a)!.name} – ${byId.get(p.b)!.name}`;
      const reason = [
        added.length ? `added ${added.map(name).join("; ")}` : null,
        removed.length ? `removed ${removed.map(name).join("; ")}` : null,
      ]
        .filter(Boolean)
        .join(". ");
      await tx.adminAuditLog.create({
        data: { actor: opts.adminId, action: "zones.neighbours", target: "ZoneAdjacency", reason: reason.slice(0, 1000) },
      });
    }
    return { added, removed };
  });
  clearZoneCache(prisma);
  return result;
}

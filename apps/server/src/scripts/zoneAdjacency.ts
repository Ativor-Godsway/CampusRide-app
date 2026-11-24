/**
 * Zone neighbours (ZoneAdjacency) — which zones dispatch treats as next door
 * (services/ride/dispatch.ts getEligibleDrivers: drivers in the pickup zone
 * and its neighbours, read in either direction). Since 2026-11-24 these are
 * real neighbours, worked out from where the zones are (@rida/shared
 * geo/zoneNeighbours: cells sharing a border, or centres within 800 m),
 * instead of a full mesh where every zone was next to every other. Admins
 * can change them by hand (admin site, Places → Zone neighbours).
 *
 *   npm run zones:check --workspace apps/server             # read-only report
 *   npm run zones:link --workspace apps/server              # dry run: what it would change
 *   npm run zones:link --workspace apps/server -- --apply   # set them to the suggested pairs
 *
 *   # Production — deliberately, with the URL you export yourself:
 *   ALLOW_PRODUCTION_DB=1 DATABASE_URL="$PROD_URL" DIRECT_URL="$PROD_URL" \
 *     npm run zones:check --workspace apps/server
 *
 * Both refuse a known production host without ALLOW_PRODUCTION_DB=1
 * (assertProductionOptIn), whatever NODE_ENV says, and print the database's
 * host only — never the connection string.
 *
 * zones:check only reads, inside a READ ONLY transaction, so the database
 * itself refuses any write. zones:link --apply makes the pairs between zones
 * in service exactly the suggested ones (one transaction; rows with a
 * retired zone are left alone), so it replaces hand edits made in admin. A
 * second run changes nothing.
 */
import type { PrismaClient } from "@prisma/client";
import { zonePairKey } from "@rida/shared";
import { SCRIPT_TX_OPTIONS } from "./scriptTx";
import { replaceZoneNeighbours, suggestedZoneNeighbours, type ZonePair } from "../services/zones/zoneNeighbours";

export interface ZoneRef {
  id: string;
  name: string;
}

export interface NamedPair {
  a: ZoneRef;
  b: ZoneRef;
}

export interface AdjacencyReport {
  /** Zones in service (retiredAt null), by name. */
  activeZones: ZoneRef[];
  /** Every row in ZoneAdjacency, retired zones included. */
  adjacencyRows: number;
  /** Rows from one zone in service to another. */
  activeRows: number;
  /** Neighbour pairs dispatch uses now (a row in either direction). */
  linked: NamedPair[];
  /** The suggested pairs, with how far apart the centres are and the border they share. */
  suggested: Array<NamedPair & { centreMeters: number; borderMeters: number }>;
  /** Suggested but not linked: a ride in one is never offered to drivers in the other. */
  missing: NamedPair[];
  /** Linked but not suggested (a full mesh, or an admin's own choice). */
  extra: NamedPair[];
  /** Linked one way only (dispatch reads either; the next zones:link --apply adds the other). */
  oneWay: NamedPair[];
  /** Every pair linked: the old full mesh. */
  fullMesh: boolean;
  /** Zones in service with no neighbour in service at all: their rides reach only their own drivers. */
  isolated: ZoneRef[];
}

/** Reads the zones and their neighbours, in a READ ONLY transaction. Changes nothing. */
export async function checkZoneAdjacency(prisma: PrismaClient): Promise<AdjacencyReport> {
  const { zones, rows, adjacencyRows, suggestion } = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const zones = await tx.zone.findMany({
      where: { retiredAt: null },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });
    const ids = zones.map((z) => z.id);
    const rows = await tx.zoneAdjacency.findMany({
      where: { zoneId: { in: ids }, adjacentZoneId: { in: ids } },
      select: { zoneId: true, adjacentZoneId: true },
    });
    const adjacencyRows = await tx.zoneAdjacency.count();
    const suggestion = await suggestedZoneNeighbours(tx);
    return { zones, rows, adjacencyRows, suggestion };
  }, SCRIPT_TX_OPTIONS);

  const byId = new Map(zones.map((z) => [z.id, z]));
  const named = (a: string, b: string): NamedPair => ({ a: byId.get(a)!, b: byId.get(b)! });
  const directed = new Set(rows.filter((r) => r.zoneId !== r.adjacentZoneId).map((r) => `${r.zoneId}>${r.adjacentZoneId}`));
  const linkedKeys = new Set<string>();
  const linked: NamedPair[] = [];
  const oneWay: NamedPair[] = [];
  for (const r of rows) {
    if (r.zoneId === r.adjacentZoneId) continue;
    const key = zonePairKey(r.zoneId, r.adjacentZoneId);
    if (linkedKeys.has(key)) continue;
    linkedKeys.add(key);
    const [a, b] = r.zoneId < r.adjacentZoneId ? [r.zoneId, r.adjacentZoneId] : [r.adjacentZoneId, r.zoneId];
    linked.push(named(a, b));
    if (!directed.has(`${a}>${b}`) || !directed.has(`${b}>${a}`)) oneWay.push(named(a, b));
  }
  const suggestedKeys = new Set(suggestion.map((p) => zonePairKey(p.a, p.b)));
  const suggested = suggestion.map((p) => ({ ...named(p.a, p.b), centreMeters: p.centreMeters, borderMeters: p.borderMeters }));
  const n = zones.length;

  return {
    activeZones: zones,
    adjacencyRows,
    activeRows: directed.size,
    linked,
    suggested,
    missing: suggested.filter((p) => !linkedKeys.has(zonePairKey(p.a.id, p.b.id))).map(({ a, b }) => ({ a, b })),
    extra: linked.filter((p) => !suggestedKeys.has(zonePairKey(p.a.id, p.b.id))),
    oneWay,
    fullMesh: n > 1 && linked.length === (n * (n - 1)) / 2,
    isolated: zones.filter((z) => n > 1 && !linked.some((p) => p.a.id === z.id || p.b.id === z.id)),
  };
}

/**
 * Sets the neighbours between zones in service to the suggested pairs.
 * Without `apply` it only reports what would change.
 */
export async function linkZones(
  prisma: PrismaClient,
  apply: boolean,
): Promise<{ before: AdjacencyReport; added: ZonePair[]; removed: ZonePair[] }> {
  const before = await checkZoneAdjacency(prisma);
  const pending = {
    added: before.missing.map((p) => ({ a: p.a.id, b: p.b.id })),
    removed: before.extra.map((p) => ({ a: p.a.id, b: p.b.id })),
  };
  if (!apply) return { before, ...pending };
  if (pending.added.length === 0 && pending.removed.length === 0 && before.oneWay.length === 0) {
    return { before, added: [], removed: [] };
  }
  const changed = await replaceZoneNeighbours(
    prisma,
    before.suggested.map((p) => ({ a: p.a.id, b: p.b.id })),
  );
  return { before, ...changed };
}

const pairName = (p: NamedPair) => `${p.a.name} – ${p.b.name}`;

/** The report as lines to print. */
export function describeReport(report: AdjacencyReport): string[] {
  const n = report.activeZones.length;
  const lines = [
    `  Zones in service:          ${n}`,
    `  Adjacency rows:            ${report.adjacencyRows}  (${report.activeRows} between zones in service)`,
    `  Neighbour pairs now:       ${report.linked.length}${report.fullMesh ? "  (a full mesh: every zone next to every other)" : ""}`,
    `  Suggested pairs:           ${report.suggested.length}  (cells sharing a border, or centres within 800 m)`,
    `  Suggested, not linked:     ${report.missing.length}`,
    `  Linked, not suggested:     ${report.extra.length}`,
    `  Linked one way only:       ${report.oneWay.length}`,
    `  Zones with no neighbours:  ${report.isolated.length === 0 ? "none" : report.isolated.map((z) => z.name).join(", ")}`,
    "",
    "Suggested neighbours:",
    ...report.suggested.map((p) => `  ${String(p.centreMeters).padStart(5)} m apart  ${pairName(p)}`),
  ];
  if (report.missing.length) lines.push("", "Suggested, not linked:", ...report.missing.map((p) => `  + ${pairName(p)}`));
  if (report.extra.length && !report.fullMesh) lines.push("", "Linked, not suggested:", ...report.extra.map((p) => `  − ${pairName(p)}`));
  lines.push(
    "",
    report.missing.length === 0 && report.extra.length === 0 && report.oneWay.length === 0
      ? "✓ The neighbours are the suggested ones."
      : report.fullMesh
        ? "✗ Still the old full mesh. Set real neighbours in the admin site (Places → Zone neighbours), or `npm run zones:link -- --apply`."
        : "• Not exactly the suggested pairs (an admin may have chosen these). `npm run zones:link` shows the difference.",
  );
  return lines;
}

/** Shared start of both commands: refuse production without the opt-in, then connect. */
export async function connectForScript(context: string): Promise<{ prisma: PrismaClient; host: string }> {
  await import("../config");
  const { assertProductionOptIn, dbHostFromUrl } = await import("../db/dbHostGuard");
  assertProductionOptIn(process.env.DATABASE_URL ?? "", context);
  const direct = process.env.DIRECT_URL;
  if (direct && direct !== process.env.DATABASE_URL) assertProductionOptIn(direct, context);
  const { prisma } = await import("../db/prisma");
  return { prisma, host: dbHostFromUrl(process.env.DATABASE_URL ?? "") ?? "?" };
}

/**
 * Is every zone in service adjacent to every other? Dispatch
 * (services/ride/dispatch.ts getEligibleDrivers) offers a ride to drivers in
 * the pickup zone and the zones adjacent to it, read from ZoneAdjacency in
 * either direction. prisma/seed.ts creates a full mesh (both directions, every
 * pair); a database seeded another way, or zones added later, can be missing
 * some of it — and then a request never reaches drivers next door.
 *
 *   npm run zones:check --workspace apps/server            # read-only report
 *   npm run zones:link --workspace apps/server             # dry run: what it would add
 *   npm run zones:link --workspace apps/server -- --apply  # add the missing rows
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
 * itself refuses any write. zones:link only INSERTs the missing rows between
 * zones in service (ON CONFLICT DO NOTHING via skipDuplicates): it never
 * deletes or changes a row, and a second run adds nothing. Retired zones are
 * left out of both: nothing new should flow through them.
 */
import type { PrismaClient } from "@prisma/client";
import { SCRIPT_TX_OPTIONS } from "./scriptTx";

export interface ZoneRef {
  id: string;
  name: string;
}

export interface AdjacencyReport {
  /** Zones in service (retiredAt null), by name. */
  activeZones: ZoneRef[];
  /** Every row in ZoneAdjacency, retired zones included. */
  adjacencyRows: number;
  /** Rows from one zone in service to another. */
  activeRows: number;
  /** Rows a full mesh between the zones in service has: n × (n − 1), both directions. */
  fullMesh: number;
  /** The rows a full mesh needs that aren't there (one per direction). */
  missing: { from: ZoneRef; to: ZoneRef }[];
  /** Pairs of zones with no row either way: a ride in one is never offered to drivers in the other. */
  unlinkedPairs: number;
  /** Zones in service with no neighbour in service at all: their rides reach only their own drivers. */
  isolated: ZoneRef[];
}

/** Reads the zones and their adjacency, in a READ ONLY transaction. Changes nothing. */
export async function checkZoneAdjacency(prisma: PrismaClient): Promise<AdjacencyReport> {
  const { zones, rows, adjacencyRows } = await prisma.$transaction(async (tx) => {
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
    return { zones, rows, adjacencyRows };
  }, SCRIPT_TX_OPTIONS);

  const linked = new Set(rows.filter((r) => r.zoneId !== r.adjacentZoneId).map((r) => `${r.zoneId}>${r.adjacentZoneId}`));
  const has = (a: ZoneRef, b: ZoneRef) => linked.has(`${a.id}>${b.id}`);

  const missing: AdjacencyReport["missing"] = [];
  let unlinkedPairs = 0;
  const isolated: ZoneRef[] = [];
  for (const a of zones) {
    let neighbours = 0;
    for (const b of zones) {
      if (a.id === b.id) continue;
      if (!has(a, b)) missing.push({ from: a, to: b });
      if (has(a, b) || has(b, a)) neighbours += 1;
      else if (a.id < b.id) unlinkedPairs += 1; // each pair counted once
    }
    if (neighbours === 0 && zones.length > 1) isolated.push(a);
  }

  return {
    activeZones: zones,
    adjacencyRows,
    activeRows: linked.size,
    fullMesh: zones.length * (zones.length - 1),
    missing,
    unlinkedPairs,
    isolated,
  };
}

/**
 * Adds the adjacency rows a full mesh between the zones in service is missing.
 * Without `apply` it only reports them. Only INSERTs (skipping any row that
 * exists by then), so it is safe to run twice; returns how many it added.
 */
export async function linkZones(
  prisma: PrismaClient,
  apply: boolean,
): Promise<{ before: AdjacencyReport; added: number }> {
  const before = await checkZoneAdjacency(prisma);
  if (!apply || before.missing.length === 0) return { before, added: 0 };
  const { count } = await prisma.zoneAdjacency.createMany({
    data: before.missing.map((m) => ({ zoneId: m.from.id, adjacentZoneId: m.to.id })),
    skipDuplicates: true,
  });
  return { before, added: count };
}

/** The report as lines to print. */
export function describeReport(report: AdjacencyReport): string[] {
  const n = report.activeZones.length;
  const lines = [
    `  Zones in service:                 ${n}`,
    `  Adjacency rows:                   ${report.adjacencyRows}  (${report.activeRows} between zones in service)`,
    `  Full mesh needs:                  ${report.fullMesh} rows  (${n} × ${Math.max(0, n - 1)}, both directions)`,
    `  Missing rows:                     ${report.missing.length}`,
    `  Zone pairs not linked either way: ${report.unlinkedPairs}  (a ride in one is never offered to drivers in the other)`,
    `  Zones with no neighbours:         ${report.isolated.length === 0 ? "none" : report.isolated.map((z) => z.name).join(", ")}`,
  ];
  lines.push(
    "",
    report.missing.length === 0
      ? "✓ Full mesh: every zone in service is adjacent to every other."
      : "✗ Not a full mesh. `npm run zones:link` shows the missing rows; `-- --apply` adds them.",
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

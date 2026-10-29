/**
 * Empties PointRoute: the routes between exact pins that the server kept
 * from the public OSRM server. Since the campus route engine (2026-10-29)
 * nothing reads or writes the table, and the routes in it may leave campus.
 * A dry run unless --apply.
 *
 *   # How many rows (dry run; any database):
 *   npm run routes:clear-point-cache --workspace apps/server
 *
 *   # Production — deliberately, with the URL you export yourself:
 *   ALLOW_PRODUCTION_DB=1 DATABASE_URL="$PROD_URL" DIRECT_URL="$PROD_URL" \
 *     npm run routes:clear-point-cache --workspace apps/server -- --apply
 *
 * Only ever deletes PointRoute rows; nothing else refers to them.
 */
import type { PrismaClient } from "@prisma/client";

export interface PointRouteCacheReport {
  rows: number;
  byProvider: Record<string, number>;
  deleted: number;
}

export async function clearPointRoutes(prisma: PrismaClient, apply: boolean): Promise<PointRouteCacheReport> {
  const groups = await prisma.pointRoute.groupBy({ by: ["provider"], _count: { _all: true } });
  const byProvider = Object.fromEntries(groups.map((g) => [g.provider, g._count._all]));
  const rows = groups.reduce((sum, g) => sum + g._count._all, 0);
  const deleted = apply ? (await prisma.pointRoute.deleteMany({})).count : 0;
  return { rows, byProvider, deleted };
}

async function main(): Promise<void> {
  const { prisma } = await import("../db/prisma");
  const { dbHostFromUrl } = await import("../db/dbHostGuard");
  try {
    const apply = process.argv.includes("--apply");
    console.log(`\nPointRoute cache  (database: ${dbHostFromUrl(process.env.DATABASE_URL ?? "") ?? "?"})`);
    console.log(apply ? "  APPLYING\n" : "  dry run — pass --apply to delete the rows\n");
    const report = await clearPointRoutes(prisma, apply);
    const by = Object.entries(report.byProvider).map(([p, n]) => `${n} from ${p}`).join(", ");
    console.log(`${report.rows} stored route(s)${by ? ` (${by})` : ""}.`);
    console.log(apply ? `Deleted ${report.deleted}.` : report.rows ? "Pass --apply to delete them." : "Nothing to delete.");
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`\n✗ ${(err as Error).message}\n`);
    process.exitCode = 1;
  });
}

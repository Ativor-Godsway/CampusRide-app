/**
 * Seed campus places from the reviewed list, prisma/data/campus-places.csv
 * (made by fetchOsmPlaces.ts, then edited by hand). Each place gets its zone
 * here: the nearest zone to it.
 *
 *   # Dev database (.env.development.local / .env.development):
 *   npm run places:seed:dev --workspace apps/server
 *
 *   # Production — deliberately, once, with the URL you export yourself:
 *   ALLOW_PRODUCTION_DB=1 DATABASE_URL="$PROD_URL" DIRECT_URL="$PROD_URL" \
 *     npm run places:seed --workspace apps/server
 *
 * Safe to re-run. A place already in the database (same `source`) is left
 * alone, because the admin Places screen is where places are changed after
 * seeding. Options:
 *   --dry-run              say what would happen, write nothing
 *   --update               overwrite name, aliases, category and position of
 *                          places already there with the CSV's (admin edits lost)
 *   --deactivate-missing   deactivate seeded places no longer in the CSV
 *
 * Needs the 20261012120000_exact_pins_and_places migration first.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { nearestZone } from "@rida/shared";
import { PLACES_CSV, fromCsv, type PlaceRow } from "./osmPlaces";

export interface SeedReport {
  created: string[];
  updated: string[];
  unchanged: number;
  deactivated: string[];
  /** Seeded places (osm:/manual: source) that are no longer in the CSV. */
  missing: string[];
}

export async function seedPlaces(
  prisma: PrismaClient,
  rows: readonly PlaceRow[],
  opts: { dryRun?: boolean; update?: boolean; deactivateMissing?: boolean } = {},
): Promise<SeedReport> {
  const zones = await prisma.zone.findMany();
  if (zones.length === 0) throw new Error("No zones in this database: seed the zones first (npm run db:seed)");
  const existing = new Map((await prisma.place.findMany()).map((p) => [p.source ?? `id:${p.id}`, p]));
  const report: SeedReport = { created: [], updated: [], unchanged: 0, deactivated: [], missing: [] };

  for (const row of rows) {
    const zoneId = nearestZone(row.latitude, row.longitude, zones)!.id;
    const data = {
      name: row.name,
      aliases: row.aliases,
      latitude: row.latitude,
      longitude: row.longitude,
      category: row.category,
      zoneId,
    };
    const found = existing.get(row.source);
    if (!found) {
      if (!opts.dryRun) await prisma.place.create({ data: { ...data, source: row.source } });
      report.created.push(row.name);
    } else if (opts.update) {
      if (!opts.dryRun) await prisma.place.update({ where: { id: found.id }, data });
      report.updated.push(row.name);
    } else {
      report.unchanged += 1;
    }
  }

  const inCsv = new Set(rows.map((r) => r.source));
  for (const [source, place] of existing) {
    if (!/^(osm|manual):/.test(source) || inCsv.has(source)) continue;
    report.missing.push(place.name);
    if (opts.deactivateMissing && place.isActive) {
      if (!opts.dryRun) await prisma.place.update({ where: { id: place.id }, data: { isActive: false } });
      report.deactivated.push(place.name);
    }
  }
  return report;
}

async function main() {
  // Imported here, not at the top, so tests can import seedPlaces without a database connection.
  await import("../../config");
  const { prisma } = await import("../../db/prisma");
  const { dbHostFromUrl } = await import("../../db/dbHostGuard");
  try {
    const dryRun = process.argv.includes("--dry-run");
    const rows = fromCsv(readFileSync(PLACES_CSV, "utf8"));
    console.log(`\nSeeding ${rows.length} places from ${path.relative(process.cwd(), PLACES_CSV)}`);
    console.log(`  database: ${dbHostFromUrl(process.env.DATABASE_URL ?? "") ?? "(unknown)"}${dryRun ? "  (dry run: nothing is written)" : ""}\n`);
    const report = await seedPlaces(prisma, rows, {
      dryRun,
      update: process.argv.includes("--update"),
      deactivateMissing: process.argv.includes("--deactivate-missing"),
    });
    const verb = dryRun ? ["Would create", "would update"] : ["Created", "updated"];
    console.log(`${verb[0]} ${report.created.length}, ${verb[1]} ${report.updated.length}, left alone ${report.unchanged}.`);
    if (report.missing.length > 0) {
      console.log(
        `${report.missing.length} seeded place(s) are no longer in the CSV${report.deactivated.length ? ` (${report.deactivated.length} deactivated)` : " — pass --deactivate-missing to hide them"}:`,
      );
      for (const name of report.missing) console.log(`  - ${name}`);
    }
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

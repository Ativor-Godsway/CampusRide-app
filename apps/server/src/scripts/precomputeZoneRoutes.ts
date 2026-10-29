/**
 * Zone-to-zone road routes (ZoneRoute) from the campus route engine: one for
 * every ordered pair of zones in service (~182). A dry run unless --apply.
 * Re-run after the zones or the campus road graph change (docs/routing.md).
 *
 *   # What would be written (dry run; any database):
 *   npm run routes:precompute --workspace apps/server
 *
 *   # Dev database:
 *   npm run routes:precompute:dev --workspace apps/server -- --apply
 *
 *   # Production — deliberately, with the URL you export yourself:
 *   ALLOW_PRODUCTION_DB=1 DATABASE_URL="$PROD_URL" DIRECT_URL="$PROD_URL" \
 *     npm run routes:precompute --workspace apps/server -- --apply
 *
 * --apply writes every route in one transaction (provider "campus") and
 * removes the stored route of any pair the campus roads can't join. It
 * touches only ZoneRoute. No network: the routes are worked out here.
 */
import "../config";
import { prisma } from "../db/prisma";
import { dbHostFromUrl } from "../db/dbHostGuard";
import { precomputeZoneRoutes } from "./zoneRoutes";

async function main() {
  const apply = process.argv.includes("--apply");
  const verbose = process.argv.includes("--verbose");
  const host = dbHostFromUrl(process.env.DATABASE_URL ?? "") ?? "(unknown)";
  console.log(`\nZone routes on campus roads  (database: ${host})`);
  console.log(apply ? "  APPLYING\n" : "  dry run — pass --apply to write them\n");

  const report = await precomputeZoneRoutes(prisma, { apply, log: verbose ? (line) => console.log(line) : undefined });

  const before = Object.entries(report.before).map(([p, n]) => `${n} from ${p}`).join(", ") || "none";
  console.log(`Stored now: ${before}.`);
  console.log(`${report.routed} of ${report.pairs} zone pairs have a campus route${apply ? " — written" : " (would be written)"}.`);
  for (const f of report.failed) console.log(`  no campus route: ${f.from} → ${f.to}${apply ? " (old route removed)" : ""}`);
  if (!verbose) console.log("(--verbose lists every route.)");
  if (apply) console.log("\nDone. The server uses them within a minute (its zone cache).");
}

main()
  .catch((err) => {
    console.error(`\n✗ ${(err as Error).message}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

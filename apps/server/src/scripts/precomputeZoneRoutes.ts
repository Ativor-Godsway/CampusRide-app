/**
 * Precompute road routes between every pair of campus zones (~210) and store
 * them in ZoneRoute, so the apps draw real roads instead of straight lines.
 * Run once per database; re-run only if zones change. Provider choice and
 * terms: docs/routing.md.
 *
 *   # Dev database (reads apps/server/.env.development):
 *   npm run routes:precompute --workspace apps/server -- --provider osrm
 *
 *   # Production — deliberately, once, with the URL you export yourself:
 *   ALLOW_PRODUCTION_DB=1 DATABASE_URL="$PROD_URL" DIRECT_URL="$PROD_URL" \
 *     npm run routes:precompute --workspace apps/server -- --provider osrm
 *
 * Options:
 *   --provider osrm|ors   which routing service (ors needs ORS_API_KEY)
 *   --only-missing        keep routes already stored, fetch the rest
 *   --limit N             fetch at most N routes (a trial run)
 *
 * It only ever WRITES ZoneRoute rows. The production database must already
 * have the 20261001120000_trip_stops_and_zone_routes migration.
 */
import "../config";
import { prisma } from "../db/prisma";
import { dbHostFromUrl } from "../db/dbHostGuard";
import { fetchRoute, precomputeZoneRoutes, PROVIDER_DEFAULTS, type RoutingProvider } from "./zoneRoutes";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const provider = (arg("--provider") ?? "osrm") as RoutingProvider;
  if (provider !== "osrm" && provider !== "ors") throw new Error(`--provider must be osrm or ors, got "${provider}"`);
  const limitRaw = arg("--limit");
  const limit = limitRaw === undefined ? undefined : Number(limitRaw);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error("--limit needs a whole number");
  const onlyMissing = process.argv.includes("--only-missing");
  const apiKey = process.env.ORS_API_KEY?.trim();
  const baseUrl = process.env.ROUTING_BASE_URL?.trim() || undefined;

  const host = dbHostFromUrl(process.env.DATABASE_URL ?? "") ?? "(unknown)";
  console.log(`\nPrecomputing zone routes with ${provider}`);
  console.log(`  database: ${host}`);
  console.log(`  service:  ${baseUrl ?? PROVIDER_DEFAULTS[provider].baseUrl}`);
  console.log(`  ${onlyMissing ? "only missing routes" : "all routes (existing ones are refreshed)"}${limit ? `, at most ${limit}` : ""}\n`);

  const report = await precomputeZoneRoutes(prisma, {
    provider,
    onlyMissing,
    limit,
    minIntervalMs: PROVIDER_DEFAULTS[provider].minIntervalMs,
    fetchOne: (from, to) => fetchRoute(provider, from, to, { baseUrl, apiKey }),
    log: (line) => console.log(line),
  });

  console.log(
    `\nDone: ${report.saved} saved, ${report.skipped} skipped, ${report.failed.length} failed (of ${report.pairs} pairs).`,
  );
  if (report.failed.length > 0) {
    console.log("Re-run with --only-missing to retry the failed ones. Until then those trips draw a straight line.");
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(`\n✗ ${(err as Error).message}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

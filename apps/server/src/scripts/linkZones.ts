/**
 * zones:link — adds the missing adjacency rows between zones in service, so
 * every zone is adjacent to every other (see zoneAdjacency.ts). A dry run
 * unless --apply; only ever INSERTs; safe to run twice.
 *
 *   npm run zones:link --workspace apps/server               # dry run
 *   npm run zones:link --workspace apps/server -- --apply
 *   ALLOW_PRODUCTION_DB=1 DATABASE_URL="$PROD_URL" DIRECT_URL="$PROD_URL" \
 *     npm run zones:link --workspace apps/server -- --apply
 */
import { checkZoneAdjacency, connectForScript, describeReport, linkZones } from "./zoneAdjacency";

async function main() {
  const apply = process.argv.includes("--apply");
  const { prisma, host } = await connectForScript("zones:link");
  try {
    console.log(`\nLink zones  (database: ${host})`);
    console.log(apply ? "  APPLYING — adds rows, never deletes or changes any\n" : "  dry run — pass --apply to add them\n");
    const { before, added } = await linkZones(prisma, apply);
    if (before.missing.length === 0) {
      console.log("Nothing to add: every zone in service is already adjacent to every other.\n");
      return;
    }
    console.log(`${apply ? "Adding" : "Would add"} ${before.missing.length} rows:`);
    for (const m of before.missing) console.log(`  ${m.from.name}  →  ${m.to.name}`);
    if (!apply) {
      console.log("\nNothing written. Re-run with -- --apply to add them.\n");
      return;
    }
    console.log(`\nAdded ${added} rows${added < before.missing.length ? ` (${before.missing.length - added} existed by then)` : ""}.\n`);
    console.log("Now:");
    for (const line of describeReport(await checkZoneAdjacency(prisma))) console.log(line);
    console.log("");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(`\n✗ ${(err as Error).message}\n`);
  process.exitCode = 1;
});

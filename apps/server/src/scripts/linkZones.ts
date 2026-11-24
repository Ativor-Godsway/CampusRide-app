/**
 * zones:link — sets the zone neighbours between zones in service to the
 * suggested pairs (see zoneAdjacency.ts). A dry run unless --apply; one
 * transaction; a second run changes nothing. Replaces hand edits made in the
 * admin site (Places → Zone neighbours).
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
    console.log(`\nSet zone neighbours  (database: ${host})`);
    console.log(apply ? "  APPLYING\n" : "  dry run — pass --apply to write\n");
    const { before, added, removed } = await linkZones(prisma, apply);
    const name = (id: string) => before.activeZones.find((z) => z.id === id)?.name ?? id;
    if (added.length === 0 && removed.length === 0 && before.oneWay.length === 0) {
      console.log("Nothing to change: the neighbours are already the suggested ones.\n");
      return;
    }
    console.log(`${apply ? "Added" : "Would add"} ${added.length} pairs:`);
    for (const p of added) console.log(`  + ${name(p.a)} – ${name(p.b)}`);
    console.log(`${apply ? "Removed" : "Would remove"} ${removed.length} pairs:`);
    for (const p of removed) console.log(`  − ${name(p.a)} – ${name(p.b)}`);
    if (!apply) {
      console.log("\nNothing written. Re-run with -- --apply to write it.\n");
      return;
    }
    console.log("\nNow:");
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

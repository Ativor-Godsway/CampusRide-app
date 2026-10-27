/**
 * zones:check — READ-ONLY report on zone adjacency (see zoneAdjacency.ts).
 *
 *   npm run zones:check --workspace apps/server
 *   ALLOW_PRODUCTION_DB=1 DATABASE_URL="$PROD_URL" DIRECT_URL="$PROD_URL" \
 *     npm run zones:check --workspace apps/server
 */
import { checkZoneAdjacency, connectForScript, describeReport } from "./zoneAdjacency";

async function main() {
  const { prisma, host } = await connectForScript("zones:check");
  try {
    console.log(`\nZone adjacency  (database: ${host}, read-only)\n`);
    const report = await checkZoneAdjacency(prisma);
    for (const line of describeReport(report)) console.log(line);
    console.log("");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(`\n✗ ${(err as Error).message}\n`);
  process.exitCode = 1;
});

/**
 * `npm run simulate:requests:cleanup` — removes every fake rider the
 * simulators made (+233099… "… (test)" accounts) and their rides, on the
 * phase2-test branch only. Never touches any other account: the real drivers
 * and riders copied from production stay (dev/sim/cleanup.ts).
 */
import "./env"; // MUST stay first: loads .env.phase2-test (or, --staging, .env.staging) and refuses anything else.
import { PrismaClient } from "@prisma/client";
import { dbHostFromUrl } from "../../db/dbHostGuard";
import { cleanupSimulatorData, SimCleanupEntangledError } from "../sim/cleanup";

async function main(): Promise<void> {
  const prisma = new PrismaClient({ log: ["error"] });
  try {
    console.log(`\nRemoving the simulator's fake riders from ${dbHostFromUrl(process.env.DATABASE_URL ?? "")}…`);
    const r = await cleanupSimulatorData(prisma);
    console.log(r.accounts === 0 ? "No fake riders found. Nothing to remove.\n" : `Removed ${r.accounts} fake riders, ${r.rides} rides, ${r.passengerRows} passenger rows, ${r.rejections} driver declines.\n`);
  } catch (err) {
    if (err instanceof SimCleanupEntangledError) {
      console.error(`\n✗ ${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw err;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(`\n✗ ${(err as Error).message}\n`);
  process.exitCode = 1;
});

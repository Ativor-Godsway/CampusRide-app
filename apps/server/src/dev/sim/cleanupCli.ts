/**
 * `npm run sim:cleanup` — removes every fake rider created by the simulator
 * and all their trips. Never touches any other account. See
 * docs/testing/SOLO_TESTING.md.
 */
import "./simEnv"; // MUST stay first: loads .env.development and refuses production.
import { PrismaClient } from "@prisma/client";
import { cleanupSimulatorData, SimCleanupEntangledError } from "./cleanup";

async function main(): Promise<void> {
  const prisma = new PrismaClient({ log: ["error"] });
  const host = new URL(process.env.DATABASE_URL!).hostname;
  console.log(`\nRemoving simulator riders from ${host}…`);
  try {
    const r = await cleanupSimulatorData(prisma);
    if (r.accounts === 0) {
      console.log("No simulator riders found. Nothing to remove.\n");
      return;
    }
    console.log("Removed:");
    for (const [label, n] of [
      ["fake rider accounts", r.accounts],
      ["rides", r.rides],
      ["passenger rows", r.passengerRows],
      ["ratings", r.ratings],
      ["commission ledger rows", r.ledgerRows],
      ["payments", r.payments],
      ["driver rejections", r.rejections],
      ["refresh tokens", r.refreshTokens],
      ["OTP codes", r.otpCodes],
    ] as const) {
      console.log(`  ${String(n).padStart(5)}  ${label}`);
    }
    console.log("\nOnly +233099… \"Test …\" rider accounts were removed. Your own accounts are untouched.\n");
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
  console.error(err);
  process.exit(1);
});

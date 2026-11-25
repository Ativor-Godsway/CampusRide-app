/**
 * `npm run prodtest:cleanup` — undoes prodtest:requests: deletes every fake
 * test rider (+233099… "(test)") and their rides, seats, offers, declines,
 * ratings and any ledger rows, then puts the test driver back to normal
 * (not review-demo, offline, no zone, online session closed) and prints the
 * counts. Never touches any other account. Safe to run twice.
 */
import { TARGET, PROD_TEST_DRIVER_PHONE } from "./guard"; // MUST stay first.
import { PrismaClient } from "@prisma/client";
import { ACTIVE_DRIVER_STATUSES } from "../../services/ride/stateMachine";
import { cleanupSimulatorData, SimCleanupEntangledError } from "../sim/cleanup";
import { simAccountWhere } from "../sim/simAccounts";

async function main() {
  const prisma = new PrismaClient({ log: ["error"] });
  try {
    console.log(`\nCampusRide production board test cleanup — ${TARGET.isProd ? "PRODUCTION" : "phase2-test copy"} (${TARGET.host})`);
    const riders = await prisma.user.findMany({ where: simAccountWhere, select: { id: true } });
    const rideIds = (await prisma.ride.findMany({ where: { riderId: { in: riders.map((r) => r.id) } }, select: { id: true } })).map((r) => r.id);
    const offers = await prisma.rideOffer.count({ where: { rideId: { in: rideIds } } });

    const r = await cleanupSimulatorData(prisma);

    const driver = await prisma.user.findUnique({ where: { phone: PROD_TEST_DRIVER_PHONE }, select: { id: true, name: true } });
    let reset = "test driver not found";
    if (driver) {
      const trip = await prisma.ride.findFirst({ where: { driverId: driver.id, status: { in: [...ACTIVE_DRIVER_STATUSES] } }, select: { id: true, isReviewDemo: true } });
      await prisma.user.update({ where: { id: driver.id }, data: { isReviewDemo: false } });
      await prisma.driver.update({ where: { userId: driver.id }, data: { isOnline: false, currentZoneId: null, autoOfflineAt: null } });
      const sessions = await prisma.driverOnlineSession.updateMany({ where: { driverUserId: driver.id, endedAt: null }, data: { endedAt: new Date(), endReason: "OFFLINE" } });
      reset = `${driver.name}: back to normal (not test mode), offline, ${sessions.count} online session closed${trip ? `. ⚠ A real trip (${trip.id}) is still yours: finish it in the app` : ", no trip"}`;
    }

    console.log("Removed:");
    for (const [n, label] of [
      [r.accounts, "fake test riders"],
      [r.rides, "test rides"],
      [r.passengerRows, "seats"],
      [offers, "offers (with the rides)"],
      [r.rejections, "driver declines"],
      [r.ratings, "ratings"],
      [r.ledgerRows, "commission ledger rows"],
      [r.payments, "payments"],
    ] as const) {
      console.log(`  ${String(n).padStart(5)}  ${label}`);
    }
    console.log(`\n${reset}.\n`);
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

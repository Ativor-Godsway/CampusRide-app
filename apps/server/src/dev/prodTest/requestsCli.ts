/**
 * `npm run prodtest:requests` — fills ONE driver's request board on
 * production with clearly marked test requests (TESTING-PROD-BOARD.md).
 *
 * - The test driver (PROD_TEST_DRIVER_PHONE) is flagged review-demo for the
 *   test: review-demo requests are offered to review-demo drivers only, and a
 *   review-demo driver gets no real requests meanwhile. prodtest:cleanup puts
 *   the account back.
 * - Fake riders: the simulator's +233099… numbers (no real number starts so),
 *   names ending "(test)", flagged review-demo: they book whatever the hours
 *   without opening CampusRide, no real driver ever sees their requests, and
 *   they owe/earn nothing and aren't counted anywhere.
 * - Refuses while CampusRide is open for real riders (the test driver would
 *   be missing from real dispatch), if the test driver has a trip, if another
 *   review-demo driver is online, or if another review-demo request is open.
 *
 *   npm run prodtest:requests --workspace apps/server -- --count 8 --minutes 3
 */
import { TARGET, PROD_TEST_DRIVER_PHONE } from "./guard"; // MUST stay first.
import { PrismaClient } from "@prisma/client";
import { formatCedis } from "@rida/shared";
import { createRide } from "../../services/ride/createRide";
import { quoteFares } from "../../services/ride/farePricing";
import { resolveRideEnd } from "../../services/places/rideEnds";
import { isServiceOpen } from "../../services/service/serviceHours";
import { ACTIVE_DRIVER_STATUSES } from "../../services/ride/stateMachine";
import { ensureSimRiders, MAX_SIM_RIDERS, simAccountWhere } from "../sim/simAccounts";
import { SIM_SPOTS, planRequests, type SpotKey } from "../requestSim/plan";

export const TEST_NOTE = "TEST RIDE (not a real rider) — CampusRide board test";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const num = (name: string, fallback: number) => (arg(name) !== undefined && Number.isFinite(Number(arg(name))) ? Number(arg(name)) : fallback);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const count = Math.min(MAX_SIM_RIDERS, Math.max(1, Math.round(num("count", 8))));
  const minutes = Math.max(0, num("minutes", 3));
  const prisma = new PrismaClient({ log: ["error"] });
  try {
    console.log(`\nCampusRide production board test — ${TARGET.isProd ? "PRODUCTION" : "phase2-test copy"} (${TARGET.host})`);

    const driver = await prisma.user.findUnique({
      where: { phone: PROD_TEST_DRIVER_PHONE },
      select: { id: true, name: true, role: true, isReviewDemo: true, deletedAt: true, driver: { select: { isApproved: true, suspendedAt: true } } },
    });
    if (!driver || driver.role !== "DRIVER" || driver.deletedAt || !driver.driver?.isApproved || driver.driver.suspendedAt) {
      throw new Error("The test driver (054 860 8146) isn't an approved, active driver here.");
    }

    const service = await isServiceOpen(prisma);
    if (service.open) throw new Error("CampusRide is OPEN for real riders right now. Run this only while it is closed (before service hours), so no real rider is affected.");

    const trip = await prisma.ride.findFirst({ where: { driverId: driver.id, status: { in: [...ACTIVE_DRIVER_STATUSES] } }, select: { id: true } });
    if (trip) throw new Error("Your driver account has a trip under way. Finish it (or run prodtest:cleanup) first.");

    const otherDemoOnline = await prisma.driver.count({ where: { isOnline: true, userId: { not: driver.id }, user: { isReviewDemo: true } } });
    if (otherDemoOnline > 0) throw new Error("Another review-demo driver (the App Store demo account) is online: it would see the test requests. Try again later.");

    const testRiders = await prisma.user.findMany({ where: simAccountWhere, select: { id: true } });
    const otherDemoOpen = await prisma.ride.count({
      where: { isReviewDemo: true, status: { in: ["REQUESTED", "AWAITING_RIDER_DECISION", ...ACTIVE_DRIVER_STATUSES] }, riderId: { notIn: testRiders.map((r) => r.id) } },
    });
    if (otherDemoOpen > 0) throw new Error("Another review-demo ride is open (the App Store demo). Try again later.");

    // The test driver: review-demo for the test (prodtest:cleanup puts it back).
    await prisma.user.update({ where: { id: driver.id }, data: { isReviewDemo: true } });
    console.log(`  ${driver.name}: TEST MODE ON — no real requests reach you until you run prodtest:cleanup.`);

    const riders = await ensureSimRiders(prisma, count);
    await prisma.user.updateMany({ where: { id: { in: riders.map((r) => r.id) }, ...simAccountWhere }, data: { isReviewDemo: true } });

    const places = new Map<SpotKey, { id: string; name: string }>();
    for (const spot of SIM_SPOTS) {
      for (const pattern of spot.patterns) {
        const p = await prisma.place.findFirst({ where: { isActive: true, name: { contains: pattern, mode: "insensitive" } }, select: { id: true, name: true }, orderBy: { name: "asc" } });
        if (p) {
          places.set(spot.key, p);
          break;
        }
      }
    }
    const spots = [...places.keys()];
    const plan = planRequests({ count, minutes, sharedRatio: 0.75, seed: Date.now() % 100_000, spots });
    console.log(`  ${count} test requests over ${minutes} min at ${spots.map((s) => places.get(s)!.name).join(", ")}\n`);

    const start = Date.now();
    for (let i = 0; i < plan.length; i++) {
      const p = plan[i]!;
      const rider = riders[i]!;
      const wait = start + p.atMs - Date.now();
      if (wait > 0) await sleep(wait);
      const pickup = { placeId: places.get(p.pickup)!.id };
      const dropoff = { placeId: places.get(p.dropoff)!.id };
      const label = `${places.get(p.pickup)!.name} → ${places.get(p.dropoff)!.name}`;
      try {
        const [from, to] = await Promise.all([resolveRideEnd(prisma, "pickup", pickup), resolveRideEnd(prisma, "dropoff", dropoff)]);
        const fare = (await quoteFares(prisma, from, to)).fares[p.type];
        await createRide(prisma, { riderId: rider.id, type: p.type, pickup, dropoff, pickupNote: TEST_NOTE, paymentMethod: "CASH", shownFare: fare });
        console.log(`  ${new Date().toLocaleTimeString("en-GB")}  ✓ ${rider.name.padEnd(14)} ${p.type === "SHARED" ? "Shared    " : "Ride alone"} ${formatCedis(fare).padEnd(6)} ${label}`);
      } catch (err) {
        console.log(`  ${new Date().toLocaleTimeString("en-GB")}  ✗ ${rider.name.padEnd(14)} ${label} — ${(err as Error).message}`);
      }
    }
    console.log("\nDone. They search for 7 minutes. When you've finished: npm run prodtest:cleanup --workspace apps/server\n");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(`\n✗ ${(err as Error).message}\n`);
  process.exitCode = 1;
});

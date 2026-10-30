import { afterEach, describe, expect, it } from "vitest";
import { haversineDistanceMeters } from "@rida/shared";
import { prisma } from "../../db/prisma";
import { cleanupRide, createTestDriver, createTestUser, getTestZones } from "./testFixtures";
import { RIDER_ETA_INTERVAL_MS, resetRiderEtasForTests, riderEtaDue, riderEtas } from "./riderEta";

// On campus (as in exactPins.test.ts).
const BALME = { latitude: 5.65201, longitude: -0.18705 };
const VOLTA = { latitude: 5.6515, longitude: -0.18969 };
const NIGHT_MARKET = { latitude: 5.64208, longitude: -0.1856 };

const rideIds: string[] = [];
afterEach(async () => {
  resetRiderEtasForTests();
  while (rideIds.length) await cleanupRide(rideIds.pop()!);
});

async function car() {
  const { pickup, dropoff } = await getTestZones();
  const { user: driver } = await createTestDriver({ isOnline: true, isApproved: true });
  const waiting = await createTestUser("RIDER");
  const aboard = await createTestUser("RIDER");
  const gone = await createTestUser("RIDER");
  const ride = await prisma.ride.create({
    data: {
      riderId: waiting.id,
      driverId: driver.id,
      type: "SHARED",
      status: "IN_PROGRESS",
      pickupZoneId: pickup.id,
      dropoffZoneId: dropoff.id,
      occupancy: 3,
      broadcastStartedAt: new Date(),
      passengers: {
        create: [
          { riderId: waiting.id, pickupZoneId: pickup.id, dropoffZoneId: dropoff.id, status: "WAITING", lockedFare: 700, pickupLat: BALME.latitude, pickupLng: BALME.longitude },
          { riderId: aboard.id, pickupZoneId: pickup.id, dropoffZoneId: dropoff.id, status: "PICKED_UP", lockedFare: 700, dropoffLat: NIGHT_MARKET.latitude, dropoffLng: NIGHT_MARKET.longitude },
          { riderId: gone.id, pickupZoneId: pickup.id, dropoffZoneId: dropoff.id, status: "DROPPED_OFF", lockedFare: 700 },
        ],
      },
    },
  });
  rideIds.push(ride.id);
  return { ride, driver, waiting, aboard, gone };
}

describe("riderEtas", () => {
  it("gives a waiting rider the road time to their pickup and a rider on board the time to their drop-off", async () => {
    const c = await car();
    const etas = await riderEtas(prisma, c.ride.id, c.driver.id, VOLTA, 1234);
    expect(etas.map((e) => e.riderId).sort()).toEqual([c.waiting.id, c.aboard.id].sort());

    const toPickup = etas.find((e) => e.riderId === c.waiting.id)!.payload;
    const toDropoff = etas.find((e) => e.riderId === c.aboard.id)!.payload;
    expect(toPickup).toMatchObject({ rideId: c.ride.id, toward: "pickup", at: 1234 });
    expect(toDropoff).toMatchObject({ rideId: c.ride.id, toward: "dropoff" });
    // On roads: at least as long as the straight line at a brisk 40 km/h.
    const atLeast = (to: typeof BALME) => haversineDistanceMeters(VOLTA, to) / (40_000 / 3600);
    expect(toPickup.seconds).toBeGreaterThan(atLeast(BALME));
    expect(toDropoff.seconds).toBeGreaterThan(atLeast(NIGHT_MARKET));
    expect(toDropoff.seconds).toBeGreaterThan(toPickup.seconds);
  });

  it("nothing for someone else's ride, or a trip that's over", async () => {
    const c = await car();
    const { user: other } = await createTestDriver({ isOnline: true, isApproved: true });
    expect(await riderEtas(prisma, c.ride.id, other.id, VOLTA)).toEqual([]);
    await prisma.driver.deleteMany({ where: { userId: other.id } });
    await prisma.user.delete({ where: { id: other.id } });
    await prisma.ride.update({ where: { id: c.ride.id }, data: { status: "COMPLETED" } });
    expect(await riderEtas(prisma, c.ride.id, c.driver.id, VOLTA)).toEqual([]);
  });
});

describe("riderEtaDue", () => {
  it("at most once per interval per ride; rides don't share it", () => {
    expect(riderEtaDue("r1", 0)).toBe(true);
    expect(riderEtaDue("r1", RIDER_ETA_INTERVAL_MS - 1)).toBe(false);
    expect(riderEtaDue("r2", 1)).toBe(true);
    expect(riderEtaDue("r1", RIDER_ETA_INTERVAL_MS)).toBe(true);
  });
});

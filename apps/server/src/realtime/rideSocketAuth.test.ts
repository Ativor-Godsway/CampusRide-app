import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "../db/prisma";
import { authorizeDriverRide, authorizeRideAccess } from "./rideSocket";
import { cleanupDriver, cleanupRide, createTestDriver, createTestRide, createTestUser } from "../services/ride/testFixtures";

const rides: string[] = [];
const drivers: string[] = [];
afterEach(async () => {
  while (rides.length) await cleanupRide(rides.pop()!);
  while (drivers.length) await cleanupDriver(drivers.pop()!);
});

async function trip(status: "MATCHED" | "ARRIVED" | "IN_PROGRESS" | "COMPLETED") {
  const { user: driver } = await createTestDriver({ isOnline: true, isApproved: true });
  drivers.push(driver.id);
  const passenger = await createTestUser("RIDER");
  const { ride } = await createTestRide({
    type: "SHARED",
    status,
    driverId: driver.id,
    passengers: [{ riderId: passenger.id, lockedFare: 500 }],
  });
  rides.push(ride.id);
  return { ride, driver, passenger };
}

describe("ride room access", () => {
  it("lets the ride's rider, its passengers and now its driver listen — nobody else", async () => {
    const { ride, driver, passenger } = await trip("MATCHED");
    const stranger = await createTestUser("RIDER");
    expect(await authorizeRideAccess(prisma, ride.id, ride.riderId)).toBe(true);
    expect(await authorizeRideAccess(prisma, ride.id, passenger.id)).toBe(true);
    expect(await authorizeRideAccess(prisma, ride.id, driver.id)).toBe(true);
    expect(await authorizeRideAccess(prisma, ride.id, stranger.id)).toBe(false);
    await prisma.user.delete({ where: { id: stranger.id } });
  });
});

describe("driver location relay", () => {
  it("is accepted for the whole trip, including on the way to the pickup", async () => {
    for (const status of ["MATCHED", "ARRIVED", "IN_PROGRESS"] as const) {
      const { ride, driver } = await trip(status);
      expect(await authorizeDriverRide(prisma, ride.id, driver.id), status).toBe(true);
    }
  });

  it("is refused after the trip, and from anyone but its driver", async () => {
    const { ride, driver, passenger } = await trip("COMPLETED");
    expect(await authorizeDriverRide(prisma, ride.id, driver.id)).toBe(false);
    const live = await trip("IN_PROGRESS");
    expect(await authorizeDriverRide(prisma, live.ride.id, passenger.id)).toBe(false);
  });
});

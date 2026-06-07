import { describe, it, expect, afterEach, afterAll } from "vitest";
import { prisma } from "../../db/prisma";
import { RideAlreadyClaimedError } from "./errors";
import { getEligibleDrivers, claimRide } from "./dispatch";
import {
  createTestRide,
  createTestUser,
  createTestDriver,
  cleanupRide,
  cleanupDriver,
  createZoneAdjacency,
  cleanupZoneAdjacencies,
  getThreeTestZones,
} from "./testFixtures";

const createdRideIds: string[] = [];
const createdDriverUserIds: string[] = [];
const createdAdjacencyIds: string[] = [];

afterEach(async () => {
  while (createdRideIds.length > 0) {
    await cleanupRide(createdRideIds.pop()!);
  }
  while (createdDriverUserIds.length > 0) {
    await cleanupDriver(createdDriverUserIds.pop()!);
  }
  await cleanupZoneAdjacencies(createdAdjacencyIds.splice(0));
});

afterAll(async () => {
  await prisma.$disconnect();
});

// ─── getEligibleDrivers ──────────────────────────────────────────────────────

describe("getEligibleDrivers", () => {
  it("returns online+approved drivers in the pickup zone or an adjacent zone, excluding others", async () => {
    const { pickup, adjacent, distant } = await getThreeTestZones();

    const adjacency = await createZoneAdjacency(pickup.id, adjacent.id);
    createdAdjacencyIds.push(adjacency.id);

    const { ride } = await createTestRide({
      type: "LONE",
      status: "REQUESTED",
      pickupZoneId: pickup.id,
    });
    createdRideIds.push(ride.id);

    const inPickup = await createTestDriver({ isOnline: true, isApproved: true, currentZoneId: pickup.id });
    const inAdjacent = await createTestDriver({ isOnline: true, isApproved: true, currentZoneId: adjacent.id });
    const offline = await createTestDriver({ isOnline: false, isApproved: true, currentZoneId: pickup.id });
    const unapproved = await createTestDriver({ isOnline: true, isApproved: false, currentZoneId: pickup.id });
    const farAway = await createTestDriver({ isOnline: true, isApproved: true, currentZoneId: distant.id });

    for (const d of [inPickup, inAdjacent, offline, unapproved, farAway]) {
      createdDriverUserIds.push(d.user.id);
    }

    const eligible = await getEligibleDrivers(prisma, ride);
    const eligibleIds = eligible.map((d) => d.id);

    expect(eligibleIds).toContain(inPickup.driver.id);
    expect(eligibleIds).toContain(inAdjacent.driver.id);
    expect(eligibleIds).not.toContain(offline.driver.id);
    expect(eligibleIds).not.toContain(unapproved.driver.id);
    expect(eligibleIds).not.toContain(farAway.driver.id);
  });
});

// ─── claimRide — atomic conditional update ──────────────────────────────────

describe("claimRide", () => {
  it("a single driver claiming a REQUESTED ride succeeds and sets MATCHED + driverId", async () => {
    const { ride } = await createTestRide({ type: "LONE", status: "REQUESTED" });
    createdRideIds.push(ride.id);

    const driver = await createTestDriver();
    createdDriverUserIds.push(driver.user.id);

    const claimed = await claimRide(prisma, ride.id, driver.user.id);

    expect(claimed.status).toBe("MATCHED");
    expect(claimed.driverId).toBe(driver.user.id);
  });

  it("claiming a ride that is already MATCHED throws RideAlreadyClaimedError", async () => {
    const driver1 = await createTestUser("DRIVER");
    const { ride } = await createTestRide({ type: "LONE", status: "MATCHED", driverId: driver1.id });
    createdRideIds.push(ride.id);

    const driver2 = await createTestDriver();
    createdDriverUserIds.push(driver2.user.id);

    await expect(claimRide(prisma, ride.id, driver2.user.id)).rejects.toThrow(
      RideAlreadyClaimedError,
    );

    const reloaded = await prisma.ride.findUniqueOrThrow({ where: { id: ride.id } });
    expect(reloaded.driverId).toBe(driver1.id);
  });

  it("claiming a CANCELLED ride throws RideAlreadyClaimedError", async () => {
    const { ride } = await createTestRide({ type: "LONE", status: "CANCELLED" });
    createdRideIds.push(ride.id);

    const driver = await createTestDriver();
    createdDriverUserIds.push(driver.user.id);

    await expect(claimRide(prisma, ride.id, driver.user.id)).rejects.toThrow(
      RideAlreadyClaimedError,
    );
  });

  it("exactly one of N concurrent claimers wins, repeated across iterations", async () => {
    const ITERATIONS = 10;
    const N = 5;

    for (let iter = 0; iter < ITERATIONS; iter++) {
      const { ride } = await createTestRide({ type: "LONE", status: "REQUESTED" });
      createdRideIds.push(ride.id);

      const drivers = [];
      for (let i = 0; i < N; i++) {
        drivers.push(await createTestDriver());
      }
      for (const d of drivers) createdDriverUserIds.push(d.user.id);

      const results = await Promise.allSettled(
        drivers.map((d) => claimRide(prisma, ride.id, d.user.id)),
      );

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(N - 1);

      for (const r of rejected) {
        expect((r as PromiseRejectedResult).reason).toBeInstanceOf(RideAlreadyClaimedError);
      }

      const winningRide = (fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof claimRide>>>).value;
      expect(winningRide.status).toBe("MATCHED");

      const reloaded = await prisma.ride.findUniqueOrThrow({ where: { id: ride.id } });
      expect(reloaded.status).toBe("MATCHED");
      expect(reloaded.driverId).toBe(winningRide.driverId);
      expect(drivers.map((d) => d.user.id)).toContain(reloaded.driverId);

      // cleanup this iteration's fixtures immediately so the loop doesn't
      // accumulate hundreds of rows before afterEach runs
      while (createdRideIds.length > 0) {
        await cleanupRide(createdRideIds.pop()!);
      }
      while (createdDriverUserIds.length > 0) {
        await cleanupDriver(createdDriverUserIds.pop()!);
      }
    }
  }, 240_000);
});

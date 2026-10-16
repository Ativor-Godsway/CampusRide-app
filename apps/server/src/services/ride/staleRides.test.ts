/**
 * Stage 6: a ride the driver never completed doesn't lock its riders out
 * forever. After RIDE_AUTO_COMPLETE_HOURS in progress the timeout sweep
 * finishes it as the driver's app would have.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { prisma } from "../../db/prisma";
import { processTimeouts } from "./timeouts";
import { isStaleInProgress } from "./staleRides";
import { findActiveRideForRider } from "./activeRide";
import { cleanupRide, createTestDriver, createTestRide, createTestUser } from "./testFixtures";

const HOUR = 60 * 60_000;
const NOW = new Date();
const rideIds: string[] = [];
const silent = { info: () => {}, warn: () => {} };

afterEach(async () => {
  while (rideIds.length) await cleanupRide(rideIds.pop()!);
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** A ride in progress since `hoursAgo`, with these passengers (the booking rider first). */
async function rideInProgress(
  type: "LONE" | "SHARED",
  hoursAgo: number,
  statuses: Array<"PICKED_UP" | "WAITING" | "ARRIVED">,
) {
  const { user: driver } = await createTestDriver();
  const { ride, rider } = await createTestRide({
    type,
    status: "IN_PROGRESS",
    driverId: driver.id,
    occupancy: statuses.length,
  });
  rideIds.push(ride.id);
  const riders = [rider.id];
  for (let i = 1; i < statuses.length; i++) riders.push((await createTestUser("RIDER")).id);
  for (const [i, status] of statuses.entries()) {
    await prisma.ridePassenger.create({
      data: {
        rideId: ride.id,
        riderId: riders[i]!,
        pickupZoneId: ride.pickupZoneId,
        dropoffZoneId: ride.dropoffZoneId,
        status,
        lockedFare: 1000,
      },
    });
  }
  await prisma.ride.update({
    where: { id: ride.id },
    data: { departedAt: new Date(NOW.getTime() - hoursAgo * HOUR) },
  });
  return { rideId: ride.id, riders, driverId: driver.id };
}

const sweep = (rideId: string, autoCompleteAfterHours?: number) =>
  processTimeouts(prisma, NOW, { rideIds: [rideId], logger: silent, autoCompleteAfterHours });

describe("isStaleInProgress", () => {
  const T0 = new Date("2026-01-01T00:00:00Z");
  const at = (ms: number) => new Date(T0.getTime() + ms);

  it("is true from 3 hours after departure", () => {
    const ride = { status: "IN_PROGRESS", createdAt: T0, departedAt: T0 };
    expect(isStaleInProgress(ride, at(3 * HOUR - 1000), 3)).toBe(false);
    expect(isStaleInProgress(ride, at(3 * HOUR), 3)).toBe(true);
  });

  it("falls back to createdAt, and ignores rides not in progress", () => {
    expect(
      isStaleInProgress(
        { status: "IN_PROGRESS", createdAt: T0, departedAt: null },
        at(4 * HOUR),
        3,
      ),
    ).toBe(true);
    expect(
      isStaleInProgress({ status: "MATCHED", createdAt: T0, departedAt: T0 }, at(10 * HOUR), 3),
    ).toBe(false);
  });
});

describe("a ride left in progress", () => {
  it("is completed after 3 hours, its rider dropped off and free to book again", async () => {
    const { rideId, riders, driverId } = await rideInProgress("LONE", 4, ["PICKED_UP"]);
    expect(await findActiveRideForRider(prisma, riders[0]!)).not.toBeNull();

    expect(await sweep(rideId)).toEqual([{ rideId, from: "IN_PROGRESS", to: "COMPLETED" }]);

    const ride = await prisma.ride.findUniqueOrThrow({
      where: { id: rideId },
      include: { passengers: true },
    });
    expect(ride.status).toBe("COMPLETED");
    expect(ride.completedAt).not.toBeNull();
    expect(ride.passengers[0]).toMatchObject({ status: "DROPPED_OFF", fareCharged: 1000 });
    expect(await prisma.commissionLedger.count({ where: { rideId, driverUserId: driverId } })).toBe(
      1,
    );
    expect(await findActiveRideForRider(prisma, riders[0]!)).toBeNull();
  });

  it("is left alone before then", async () => {
    const { rideId } = await rideInProgress("LONE", 2, ["PICKED_UP"]);
    expect(await sweep(rideId)).toEqual([]);
    expect((await prisma.ride.findUniqueOrThrow({ where: { id: rideId } })).status).toBe(
      "IN_PROGRESS",
    );
  });

  it("in a shared car: riders aboard are dropped off, riders still waiting are released", async () => {
    const { rideId, riders } = await rideInProgress("SHARED", 5, [
      "PICKED_UP",
      "WAITING",
      "ARRIVED",
    ]);
    await sweep(rideId);
    const ride = await prisma.ride.findUniqueOrThrow({
      where: { id: rideId },
      include: { passengers: true },
    });
    expect(ride.status).toBe("COMPLETED");
    const byRider = Object.fromEntries(ride.passengers.map((p) => [p.riderId, p.status]));
    expect(byRider).toEqual({
      [riders[0]!]: "DROPPED_OFF",
      [riders[1]!]: "CANCELLED",
      [riders[2]!]: "CANCELLED",
    });
    for (const riderId of riders) expect(await findActiveRideForRider(prisma, riderId)).toBeNull();
  });

  it("follows RIDE_AUTO_COMPLETE_HOURS", async () => {
    const { rideId } = await rideInProgress("LONE", 2, ["PICKED_UP"]);
    expect(await sweep(rideId, 1)).toEqual([{ rideId, from: "IN_PROGRESS", to: "COMPLETED" }]);
  });
});

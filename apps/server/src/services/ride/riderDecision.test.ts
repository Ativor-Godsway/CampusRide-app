import { describe, it, expect, afterEach, afterAll } from "vitest";
import { prisma } from "../../db/prisma";
import { riderDecision } from "./riderDecision";
import { InvalidSwitchToLoneError } from "./errors";
import { createTestRide, createTestUser, cleanupRide } from "./testFixtures";

const createdRideIds: string[] = [];

afterEach(async () => {
  while (createdRideIds.length > 0) {
    await cleanupRide(createdRideIds.pop()!);
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

const T0 = new Date("2026-01-01T00:00:00.000Z");

describe("riderDecision — KEEP_WAITING", () => {
  it("AWAITING_RIDER_DECISION -> REQUESTED, resets broadcastStartedAt and clears decisionStartedAt", async () => {
    const { ride } = await createTestRide({
      type: "LONE",
      status: "AWAITING_RIDER_DECISION",
      broadcastStartedAt: T0,
      decisionStartedAt: T0,
    });
    createdRideIds.push(ride.id);

    const now = new Date(T0.getTime() + 90_000);
    const updated = await riderDecision(prisma, ride.id, "KEEP_WAITING", now);

    expect(updated.status).toBe("REQUESTED");
    expect(updated.broadcastStartedAt?.getTime()).toBe(now.getTime());
    expect(updated.decisionStartedAt).toBeNull();
  });
});

describe("riderDecision — CANCEL", () => {
  it("AWAITING_RIDER_DECISION -> CANCELLED with cancelReason RIDER_CANCELLED", async () => {
    const { ride } = await createTestRide({
      type: "LONE",
      status: "AWAITING_RIDER_DECISION",
      broadcastStartedAt: T0,
      decisionStartedAt: T0,
    });
    createdRideIds.push(ride.id);

    const updated = await riderDecision(prisma, ride.id, "CANCEL", T0);

    expect(updated.status).toBe("CANCELLED");
    expect(updated.cancelReason).toBe("RIDER_CANCELLED");
  });
});

describe("riderDecision — SWITCH_TO_LONE", () => {
  it("with exactly 1 active passenger: ride becomes LONE, passenger locks at 1500, REQUESTED", async () => {
    const riderA = await createTestUser("RIDER");
    const { ride } = await createTestRide({
      type: "SHARED",
      status: "AWAITING_RIDER_DECISION",
      occupancy: 1,
      broadcastStartedAt: T0,
      decisionStartedAt: T0,
      passengers: [{ riderId: riderA.id, status: "WAITING", lockedFare: 1000 }],
    });
    createdRideIds.push(ride.id);

    const passengerA = ride.passengers[0]!;

    const now = new Date(T0.getTime() + 90_000);
    const updated = await riderDecision(prisma, ride.id, "SWITCH_TO_LONE", now);

    expect(updated.type).toBe("LONE");
    expect(updated.status).toBe("REQUESTED");
    expect(updated.broadcastStartedAt?.getTime()).toBe(now.getTime());
    expect(updated.decisionStartedAt).toBeNull();

    const reloadedPassenger = await prisma.ridePassenger.findUniqueOrThrow({
      where: { id: passengerA.id },
    });
    expect(reloadedPassenger.lockedFare).toBe(1500);
  });

  it("with 2 active passengers: rejected with InvalidSwitchToLoneError, ride unchanged", async () => {
    const riderA = await createTestUser("RIDER");
    const riderB = await createTestUser("RIDER");
    const { ride } = await createTestRide({
      type: "SHARED",
      status: "AWAITING_RIDER_DECISION",
      occupancy: 2,
      broadcastStartedAt: T0,
      decisionStartedAt: T0,
      passengers: [
        { riderId: riderA.id, status: "WAITING", lockedFare: 700 },
        { riderId: riderB.id, status: "WAITING", lockedFare: 700 },
      ],
    });
    createdRideIds.push(ride.id);

    await expect(
      riderDecision(prisma, ride.id, "SWITCH_TO_LONE", new Date(T0.getTime() + 90_000)),
    ).rejects.toThrow(InvalidSwitchToLoneError);

    const reloaded = await prisma.ride.findUniqueOrThrow({ where: { id: ride.id } });
    expect(reloaded.status).toBe("AWAITING_RIDER_DECISION");
    expect(reloaded.type).toBe("SHARED");

    const passengers = await prisma.ridePassenger.findMany({ where: { rideId: ride.id } });
    for (const p of passengers) {
      expect(p.lockedFare).toBe(700);
    }
  });
});

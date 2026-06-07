import { describe, it, expect, afterEach, afterAll } from "vitest";
import { prisma } from "../../db/prisma";
import { shouldTimeout, shouldExpireDecision, processTimeouts } from "./timeouts";
import { riderDecision } from "./riderDecision";
import { createTestRide, cleanupRide } from "./testFixtures";

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

// ─── Pure functions ──────────────────────────────────────────────────────────

describe("shouldTimeout", () => {
  it("is false for a REQUESTED ride at 89s since broadcastStartedAt", () => {
    const ride = { status: "REQUESTED", createdAt: T0, broadcastStartedAt: T0, decisionStartedAt: null };
    expect(shouldTimeout(ride, new Date(T0.getTime() + 89_000))).toBe(false);
  });

  it("is true for a REQUESTED ride at 90s since broadcastStartedAt", () => {
    const ride = { status: "REQUESTED", createdAt: T0, broadcastStartedAt: T0, decisionStartedAt: null };
    expect(shouldTimeout(ride, new Date(T0.getTime() + 90_000))).toBe(true);
  });

  it("falls back to createdAt when broadcastStartedAt is null", () => {
    const ride = { status: "REQUESTED", createdAt: T0, broadcastStartedAt: null, decisionStartedAt: null };
    expect(shouldTimeout(ride, new Date(T0.getTime() + 90_000))).toBe(true);
    expect(shouldTimeout(ride, new Date(T0.getTime() + 89_000))).toBe(false);
  });

  it("is false for non-REQUESTED rides regardless of elapsed time", () => {
    const ride = { status: "MATCHED", createdAt: T0, broadcastStartedAt: T0, decisionStartedAt: null };
    expect(shouldTimeout(ride, new Date(T0.getTime() + 1_000_000))).toBe(false);
  });
});

describe("shouldExpireDecision", () => {
  it("is false before 90s since decisionStartedAt", () => {
    const ride = { status: "AWAITING_RIDER_DECISION", createdAt: T0, broadcastStartedAt: T0, decisionStartedAt: T0 };
    expect(shouldExpireDecision(ride, new Date(T0.getTime() + 89_000))).toBe(false);
  });

  it("is true at 90s since decisionStartedAt", () => {
    const ride = { status: "AWAITING_RIDER_DECISION", createdAt: T0, broadcastStartedAt: T0, decisionStartedAt: T0 };
    expect(shouldExpireDecision(ride, new Date(T0.getTime() + 90_000))).toBe(true);
  });

  it("is false for rides not in AWAITING_RIDER_DECISION", () => {
    const ride = { status: "REQUESTED", createdAt: T0, broadcastStartedAt: T0, decisionStartedAt: T0 };
    expect(shouldExpireDecision(ride, new Date(T0.getTime() + 1_000_000))).toBe(false);
  });
});

// ─── processTimeouts — orchestration with injected `now` ────────────────────

describe("processTimeouts", () => {
  it("REQUESTED ride at 89s is left unchanged", async () => {
    const { ride } = await createTestRide({
      type: "LONE",
      status: "REQUESTED",
      broadcastStartedAt: T0,
    });
    createdRideIds.push(ride.id);

    await processTimeouts(prisma, new Date(T0.getTime() + 89_000), { rideIds: [ride.id] });

    const reloaded = await prisma.ride.findUniqueOrThrow({ where: { id: ride.id } });
    expect(reloaded.status).toBe("REQUESTED");
  });

  it("REQUESTED ride at 90s moves to AWAITING_RIDER_DECISION and stamps decisionStartedAt", async () => {
    const { ride } = await createTestRide({
      type: "LONE",
      status: "REQUESTED",
      broadcastStartedAt: T0,
    });
    createdRideIds.push(ride.id);

    const now = new Date(T0.getTime() + 90_000);
    await processTimeouts(prisma, now, { rideIds: [ride.id] });

    const reloaded = await prisma.ride.findUniqueOrThrow({ where: { id: ride.id } });
    expect(reloaded.status).toBe("AWAITING_RIDER_DECISION");
    expect(reloaded.decisionStartedAt?.getTime()).toBe(now.getTime());
  });

  it("KEEP_WAITING resets the broadcast clock so the ride is not immediately re-timed-out", async () => {
    const { ride } = await createTestRide({
      type: "LONE",
      status: "REQUESTED",
      broadcastStartedAt: T0,
    });
    createdRideIds.push(ride.id);

    const timeoutAt = new Date(T0.getTime() + 90_000);
    await processTimeouts(prisma, timeoutAt, { rideIds: [ride.id] });

    let reloaded = await prisma.ride.findUniqueOrThrow({ where: { id: ride.id } });
    expect(reloaded.status).toBe("AWAITING_RIDER_DECISION");

    await riderDecision(prisma, ride.id, "KEEP_WAITING", timeoutAt);

    reloaded = await prisma.ride.findUniqueOrThrow({ where: { id: ride.id } });
    expect(reloaded.status).toBe("REQUESTED");
    expect(reloaded.broadcastStartedAt?.getTime()).toBe(timeoutAt.getTime());

    // Without the reset, now - T0 (original broadcastStartedAt) would be 91s >= 90s.
    // With the reset, now - timeoutAt = 1s < 90s, so no re-timeout.
    const oneSecondLater = new Date(timeoutAt.getTime() + 1_000);
    await processTimeouts(prisma, oneSecondLater, { rideIds: [ride.id] });

    reloaded = await prisma.ride.findUniqueOrThrow({ where: { id: ride.id } });
    expect(reloaded.status).toBe("REQUESTED");
  });

  it("AWAITING_RIDER_DECISION idle for 90s is auto-cancelled with NO_DRIVERS_AVAILABLE", async () => {
    const { ride } = await createTestRide({
      type: "LONE",
      status: "AWAITING_RIDER_DECISION",
      broadcastStartedAt: T0,
      decisionStartedAt: T0,
    });
    createdRideIds.push(ride.id);

    await processTimeouts(prisma, new Date(T0.getTime() + 90_000), { rideIds: [ride.id] });

    const reloaded = await prisma.ride.findUniqueOrThrow({ where: { id: ride.id } });
    expect(reloaded.status).toBe("CANCELLED");
    expect(reloaded.cancelReason).toBe("NO_DRIVERS_AVAILABLE");
  });

  it("AWAITING_RIDER_DECISION at 89s is left unchanged", async () => {
    const { ride } = await createTestRide({
      type: "LONE",
      status: "AWAITING_RIDER_DECISION",
      broadcastStartedAt: T0,
      decisionStartedAt: T0,
    });
    createdRideIds.push(ride.id);

    await processTimeouts(prisma, new Date(T0.getTime() + 89_000), { rideIds: [ride.id] });

    const reloaded = await prisma.ride.findUniqueOrThrow({ where: { id: ride.id } });
    expect(reloaded.status).toBe("AWAITING_RIDER_DECISION");
  });
});

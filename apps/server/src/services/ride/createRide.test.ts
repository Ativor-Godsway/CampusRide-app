import { describe, it, expect, vi, afterEach } from "vitest";
import { prisma } from "../../db/prisma";
import { createTestUser, getTestZones } from "./testFixtures";
import * as dispatch from "./dispatch";

const createdUserIds: string[] = [];
const createdRideIds: string[] = [];

afterEach(async () => {
  while (createdRideIds.length > 0) {
    await prisma.ride.deleteMany({ where: { id: createdRideIds.pop()! } });
  }
  while (createdUserIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: createdUserIds.pop()! } });
  }
  vi.restoreAllMocks();
});

/**
 * "Silent DB write, no broadcast" is a known bug class for this extraction
 * (Checkpoint 4 follow-up) — assert broadcastRide actually fires for BOTH
 * source values, not just that the DB row looks right. Re-imports createRide
 * dynamically per test so the spy on dispatch.broadcastRide (installed
 * before the import resolves the module graph) is in effect.
 */
describe("createRide broadcasts identically regardless of source", () => {
  it("fires broadcastRide with the new ride's id for an APP-sourced ride", async () => {
    vi.spyOn(dispatch, "broadcastRide").mockResolvedValue([]);
    const { createRide } = await import("./createRide");

    const rider = await createTestUser("RIDER");
    createdUserIds.push(rider.id);
    const { pickup, dropoff } = await getTestZones();

    const ride = await createRide(prisma, {
      riderId: rider.id,
      type: "LONE",
      pickupZoneId: pickup.id,
      dropoffZoneId: dropoff.id,
    });
    createdRideIds.push(ride.id);

    expect(ride.source).toBe("APP");
    expect(dispatch.broadcastRide).toHaveBeenCalledTimes(1);
    // Compare only the rideId arg — deep-equating the full PrismaClient
    // instance (huge, circular) crashes vitest's diff printer on mismatch.
    const [, calledRideId] = vi.mocked(dispatch.broadcastRide).mock.calls[0]!;
    expect(calledRideId).toBe(ride.id);
  });

  it("fires broadcastRide with the new ride's id for a USSD-sourced ride (the path Checkpoint 4 verified the DB row for, but not this)", async () => {
    vi.spyOn(dispatch, "broadcastRide").mockResolvedValue([]);
    const { createRide } = await import("./createRide");

    const rider = await createTestUser("RIDER");
    createdUserIds.push(rider.id);
    const { pickup, dropoff } = await getTestZones();

    const ride = await createRide(prisma, {
      riderId: rider.id,
      type: "SHARED",
      pickupZoneId: pickup.id,
      dropoffZoneId: dropoff.id,
      source: "USSD",
    });
    createdRideIds.push(ride.id);

    expect(ride.source).toBe("USSD");
    expect(dispatch.broadcastRide).toHaveBeenCalledTimes(1);
    const [, calledRideId] = vi.mocked(dispatch.broadcastRide).mock.calls[0]!;
    expect(calledRideId).toBe(ride.id);
  });
});

/**
 * Phase 2: the rider-facing read endpoints return an explicit field list, not
 * "every column on the model". These tests pin the exact key sets, so adding
 * a column to User/Ride/RidePassenger cannot quietly publish it — the test
 * fails and the decision has to be made deliberately in routes/selects.ts.
 */
import { describe, it, expect, afterEach, afterAll, beforeAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { prisma } from "../db/prisma";
import { registerRideRoutes } from "./rides";
import { registerAuthRoutes } from "./auth";
import { signAccessToken } from "../services/auth/tokens";
import { otpService } from "../services/active";
import { createTestUser, createTestRide, cleanupRide } from "../services/ride/testFixtures";

let app: FastifyInstance;
const createdRideIds: string[] = [];

beforeAll(async () => {
  app = Fastify();
  registerRideRoutes(app, prisma);
  registerAuthRoutes(app, prisma, otpService);
  await app.ready();
});

afterEach(async () => {
  while (createdRideIds.length > 0) {
    await cleanupRide(createdRideIds.pop()!);
  }
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

const RIDE_KEYS = [
  "id",
  "riderId",
  "driverId",
  "type",
  "status",
  "source",
  "pickupZoneId",
  "dropoffZoneId",
  "occupancy",
  "fareTotal",
  "paymentStatus",
  "paymentMethod",
  "cancelReason",
  "mergedIntoRideId",
  "createdAt",
  "departedAt",
  "completedAt",
  "broadcastStartedAt",
  "decisionStartedAt",
].sort();

const ZONE_KEYS = ["id", "name", "quadrant", "latitude", "longitude"].sort();

describe("GET /me", () => {
  it("returns exactly the whitelisted user fields", async () => {
    const rider = await createTestUser("RIDER");
    const token = signAccessToken({ userId: rider.id, role: "RIDER" });

    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const { user } = res.json();
    expect(Object.keys(user).sort()).toEqual(
      [
        "id",
        "phone",
        "name",
        "role",
        "createdAt",
        "driver",
        // Phase 4: the rider's single emergency contact, needed by the
        // account screen to show and edit what is currently set.
        "emergencyContactName",
        "emergencyContactPhone",
      ].sort(),
    );
    // updatedAt is internal bookkeeping and must not be published.
    expect(user).not.toHaveProperty("updatedAt");
    await prisma.user.delete({ where: { id: rider.id } });
  });
});

describe("GET /rides/mine", () => {
  it("returns exactly the whitelisted ride + zone fields", async () => {
    const { ride, rider } = await createTestRide({ type: "LONE" });
    createdRideIds.push(ride.id);
    const token = signAccessToken({ userId: rider.id, role: "RIDER" });

    const res = await app.inject({
      method: "GET",
      url: "/rides/mine",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const { rides } = res.json();
    expect(rides.length).toBeGreaterThan(0);

    const [first] = rides;
    expect(Object.keys(first).sort()).toEqual([...RIDE_KEYS, "pickupZone", "dropoffZone"].sort());
    expect(Object.keys(first.pickupZone).sort()).toEqual(ZONE_KEYS);

    // The platform's fare split is not the rider's business.
    expect(first).not.toHaveProperty("driverShare");
  });
});

describe("GET /rides/:id", () => {
  it("returns exactly the whitelisted ride + zone + passenger fields", async () => {
    const { ride, rider } = await createTestRide({ type: "LONE" });
    createdRideIds.push(ride.id);
    await prisma.ridePassenger.create({
      data: {
        rideId: ride.id,
        riderId: rider.id,
        pickupZoneId: ride.pickupZoneId,
        dropoffZoneId: ride.dropoffZoneId,
        status: "WAITING",
        lockedFare: 500,
      },
    });
    const token = signAccessToken({ userId: rider.id, role: "RIDER" });

    const res = await app.inject({
      method: "GET",
      url: `/rides/${ride.id}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body.ride).sort()).toEqual(
      [...RIDE_KEYS, "pickupZone", "dropoffZone", "passengers"].sort(),
    );
    expect(body.ride).not.toHaveProperty("driverShare");

    expect(Object.keys(body.ride.passengers[0]).sort()).toEqual(
      ["id", "rideId", "riderId", "pickupZoneId", "dropoffZoneId", "fareCharged", "lockedFare", "status"].sort(),
    );
  });

  it("still enforces access control on the narrowed shape", async () => {
    const { ride } = await createTestRide({ type: "LONE" });
    createdRideIds.push(ride.id);
    const stranger = await createTestUser("RIDER");
    const token = signAccessToken({ userId: stranger.id, role: "RIDER" });

    const res = await app.inject({
      method: "GET",
      url: `/rides/${ride.id}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(403);
    await prisma.user.delete({ where: { id: stranger.id } });
  });
});

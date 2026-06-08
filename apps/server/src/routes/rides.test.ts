import { describe, it, expect, afterEach, afterAll, beforeAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { prisma } from "../db/prisma";
import { registerRideRoutes } from "./rides";
import { registerZoneRoutes } from "./zones";
import { signAccessToken } from "../services/auth/tokens";
import { createTestUser, createTestRide, getTestZones, cleanupRide } from "../services/ride/testFixtures";

let app: FastifyInstance;
const createdRideIds: string[] = [];

beforeAll(async () => {
  app = Fastify();
  registerRideRoutes(app, prisma);
  registerZoneRoutes(app, prisma);
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

/** Creates a throwaway rider + access token. Cleaned up via cleanupRide if a ride is created from it. */
async function authedRider() {
  const rider = await createTestUser("RIDER");
  const token = signAccessToken({ userId: rider.id, role: "RIDER" });
  return { rider, token };
}

describe("GET /zones", () => {
  it("requires auth", async () => {
    const res = await app.inject({ method: "GET", url: "/zones" });
    expect(res.statusCode).toBe(401);
  });

  it("returns the seeded zones", async () => {
    const { token } = await authedRider();
    const res = await app.inject({
      method: "GET",
      url: "/zones",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.zones)).toBe(true);
    expect(body.zones.length).toBeGreaterThan(0);
    expect(body.zones[0]).toHaveProperty("latitude");
  });
});

describe("POST /rides", () => {
  it("requires auth", async () => {
    const res = await app.inject({ method: "POST", url: "/rides", payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it("rejects missing fields", async () => {
    const { token } = await authedRider();
    const res = await app.inject({
      method: "POST",
      url: "/rides",
      headers: { authorization: `Bearer ${token}` },
      payload: { type: "LONE" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an invalid ride type", async () => {
    const { token } = await authedRider();
    const { pickup, dropoff } = await getTestZones();
    const res = await app.inject({
      method: "POST",
      url: "/rides",
      headers: { authorization: `Bearer ${token}` },
      payload: { pickupZoneId: pickup.id, dropoffZoneId: dropoff.id, type: "SOLO" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects identical pickup and dropoff zones", async () => {
    const { token } = await authedRider();
    const { pickup } = await getTestZones();
    const res = await app.inject({
      method: "POST",
      url: "/rides",
      headers: { authorization: `Bearer ${token}` },
      payload: { pickupZoneId: pickup.id, dropoffZoneId: pickup.id, type: "LONE" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("creates a REQUESTED ride and rejects a second active ride for the same rider", async () => {
    const { token } = await authedRider();
    const { pickup, dropoff } = await getTestZones();

    const res = await app.inject({
      method: "POST",
      url: "/rides",
      headers: { authorization: `Bearer ${token}` },
      payload: { pickupZoneId: pickup.id, dropoffZoneId: dropoff.id, type: "SHARED" },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.ride.status).toBe("REQUESTED");
    expect(body.ride.type).toBe("SHARED");
    expect(body.ride.occupancy).toBe(1);
    expect(body.ride.broadcastStartedAt).not.toBeNull();
    createdRideIds.push(body.ride.id);

    const second = await app.inject({
      method: "POST",
      url: "/rides",
      headers: { authorization: `Bearer ${token}` },
      payload: { pickupZoneId: pickup.id, dropoffZoneId: dropoff.id, type: "LONE" },
    });
    expect(second.statusCode).toBe(409);
  });

  it("creates a RidePassenger row for the requesting rider with the locked fare", async () => {
    const { token } = await authedRider();
    const { pickup, dropoff } = await getTestZones();

    const res = await app.inject({
      method: "POST",
      url: "/rides",
      headers: { authorization: `Bearer ${token}` },
      payload: { pickupZoneId: pickup.id, dropoffZoneId: dropoff.id, type: "LONE" },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    createdRideIds.push(body.ride.id);
    expect(body.ride.passengers).toHaveLength(1);
    expect(body.ride.passengers[0].status).toBe("WAITING");
    expect(body.ride.passengers[0].lockedFare).toBe(1500);
  });
});

describe("GET /rides/:id", () => {
  it("requires auth", async () => {
    const res = await app.inject({ method: "GET", url: "/rides/nonexistent" });
    expect(res.statusCode).toBe(401);
  });

  it("404s for an unknown ride", async () => {
    const { token } = await authedRider();
    const res = await app.inject({
      method: "GET",
      url: "/rides/nonexistent",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("403s for a rider who is neither the ride's rider nor a passenger", async () => {
    const { ride } = await createTestRide({ type: "LONE", status: "REQUESTED" });
    createdRideIds.push(ride.id);
    const { token } = await authedRider();

    const res = await app.inject({
      method: "GET",
      url: `/rides/${ride.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns the ride with zones and a null driver when unassigned", async () => {
    const { ride, rider } = await createTestRide({ type: "LONE", status: "REQUESTED" });
    createdRideIds.push(ride.id);
    const token = signAccessToken({ userId: rider.id, role: "RIDER" });

    const res = await app.inject({
      method: "GET",
      url: `/rides/${ride.id}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ride.id).toBe(ride.id);
    expect(body.ride.pickupZone).toHaveProperty("latitude");
    expect(body.ride.dropoffZone).toHaveProperty("latitude");
    expect(body.driver).toBeNull();
  });
});

describe("POST /rides/:id/decision", () => {
  it("requires auth", async () => {
    const res = await app.inject({ method: "POST", url: "/rides/nonexistent/decision", payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it("rejects an invalid action", async () => {
    const { ride, rider } = await createTestRide({
      type: "LONE",
      status: "AWAITING_RIDER_DECISION",
      decisionStartedAt: new Date(),
    });
    createdRideIds.push(ride.id);
    const token = signAccessToken({ userId: rider.id, role: "RIDER" });

    const res = await app.inject({
      method: "POST",
      url: `/rides/${ride.id}/decision`,
      headers: { authorization: `Bearer ${token}` },
      payload: { action: "GIVE_UP" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("403s for a rider who doesn't own the ride", async () => {
    const { ride } = await createTestRide({
      type: "LONE",
      status: "AWAITING_RIDER_DECISION",
      decisionStartedAt: new Date(),
    });
    createdRideIds.push(ride.id);
    const { token } = await authedRider();

    const res = await app.inject({
      method: "POST",
      url: `/rides/${ride.id}/decision`,
      headers: { authorization: `Bearer ${token}` },
      payload: { action: "CANCEL" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("409s when the ride isn't AWAITING_RIDER_DECISION", async () => {
    const { ride, rider } = await createTestRide({ type: "LONE", status: "REQUESTED" });
    createdRideIds.push(ride.id);
    const token = signAccessToken({ userId: rider.id, role: "RIDER" });

    const res = await app.inject({
      method: "POST",
      url: `/rides/${ride.id}/decision`,
      headers: { authorization: `Bearer ${token}` },
      payload: { action: "CANCEL" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("KEEP_WAITING moves the ride back to REQUESTED", async () => {
    const { ride, rider } = await createTestRide({
      type: "LONE",
      status: "AWAITING_RIDER_DECISION",
      decisionStartedAt: new Date(),
    });
    createdRideIds.push(ride.id);
    const token = signAccessToken({ userId: rider.id, role: "RIDER" });

    const res = await app.inject({
      method: "POST",
      url: `/rides/${ride.id}/decision`,
      headers: { authorization: `Bearer ${token}` },
      payload: { action: "KEEP_WAITING" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().ride.status).toBe("REQUESTED");
  });

  it("CANCEL cancels the ride with reason RIDER_CANCELLED", async () => {
    const { ride, rider } = await createTestRide({
      type: "LONE",
      status: "AWAITING_RIDER_DECISION",
      decisionStartedAt: new Date(),
    });
    createdRideIds.push(ride.id);
    const token = signAccessToken({ userId: rider.id, role: "RIDER" });

    const res = await app.inject({
      method: "POST",
      url: `/rides/${ride.id}/decision`,
      headers: { authorization: `Bearer ${token}` },
      payload: { action: "CANCEL" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ride.status).toBe("CANCELLED");
    expect(body.ride.cancelReason).toBe("RIDER_CANCELLED");
  });

  it("SWITCH_TO_LONE 409s when occupancy != 1", async () => {
    const riderB = await createTestUser("RIDER");
    const { ride, rider } = await createTestRide({
      type: "SHARED",
      status: "AWAITING_RIDER_DECISION",
      decisionStartedAt: new Date(),
      occupancy: 2,
      passengers: [{ riderId: riderB.id, status: "WAITING", lockedFare: 700 }],
    });
    await prisma.ridePassenger.create({
      data: {
        rideId: ride.id,
        riderId: rider.id,
        pickupZoneId: ride.pickupZoneId,
        dropoffZoneId: ride.dropoffZoneId,
        status: "WAITING",
        lockedFare: 700,
      },
    });
    createdRideIds.push(ride.id);
    const token = signAccessToken({ userId: rider.id, role: "RIDER" });

    const res = await app.inject({
      method: "POST",
      url: `/rides/${ride.id}/decision`,
      headers: { authorization: `Bearer ${token}` },
      payload: { action: "SWITCH_TO_LONE" },
    });

    expect(res.statusCode).toBe(409);
  });
});

describe("POST /rides/:id/cancel", () => {
  it("requires auth", async () => {
    const res = await app.inject({ method: "POST", url: "/rides/nonexistent/cancel", payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it("403s for a rider who doesn't own the ride", async () => {
    const { ride } = await createTestRide({ type: "LONE", status: "REQUESTED" });
    createdRideIds.push(ride.id);
    const { token } = await authedRider();

    const res = await app.inject({
      method: "POST",
      url: `/rides/${ride.id}/cancel`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("cancels a REQUESTED ride with reason RIDER_CANCELLED", async () => {
    const { ride, rider } = await createTestRide({ type: "LONE", status: "REQUESTED" });
    createdRideIds.push(ride.id);
    const token = signAccessToken({ userId: rider.id, role: "RIDER" });

    const res = await app.inject({
      method: "POST",
      url: `/rides/${ride.id}/cancel`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ride.status).toBe("CANCELLED");
    expect(body.ride.cancelReason).toBe("RIDER_CANCELLED");
  });

  it("409s for an IN_PROGRESS ride (point of no return)", async () => {
    const { ride, rider } = await createTestRide({
      type: "LONE",
      status: "IN_PROGRESS",
    });
    createdRideIds.push(ride.id);
    const token = signAccessToken({ userId: rider.id, role: "RIDER" });

    const res = await app.inject({
      method: "POST",
      url: `/rides/${ride.id}/cancel`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(409);
  });
});

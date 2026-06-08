import { describe, it, expect, afterEach, afterAll, beforeAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { prisma } from "../db/prisma";
import { registerRideRoutes } from "./rides";
import { registerZoneRoutes } from "./zones";
import { signAccessToken } from "../services/auth/tokens";
import { createTestUser, getTestZones, cleanupRide } from "../services/ride/testFixtures";

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
});

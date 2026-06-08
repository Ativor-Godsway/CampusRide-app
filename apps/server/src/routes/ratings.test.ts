import { describe, it, expect, afterEach, afterAll, beforeAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { prisma } from "../db/prisma";
import { registerRatingRoutes } from "./ratings";
import { signAccessToken } from "../services/auth/tokens";
import {
  createTestRide,
  createTestDriver,
  createTestUser,
  cleanupRide,
  cleanupDriver,
} from "../services/ride/testFixtures";

let app: FastifyInstance;
const createdRideIds: string[] = [];
const createdDriverUserIds: string[] = [];

beforeAll(async () => {
  app = Fastify();
  registerRatingRoutes(app, prisma);
  await app.ready();
});

afterEach(async () => {
  while (createdRideIds.length > 0) {
    await cleanupRide(createdRideIds.pop()!);
  }
  while (createdDriverUserIds.length > 0) {
    await cleanupDriver(createdDriverUserIds.pop()!);
  }
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("POST /ratings", () => {
  it("requires auth", async () => {
    const res = await app.inject({ method: "POST", url: "/ratings", payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it("rejects missing rideId / invalid stars", async () => {
    const rider = await createTestUser("RIDER");
    const token = signAccessToken({ userId: rider.id, role: "RIDER" });

    const res = await app.inject({
      method: "POST",
      url: "/ratings",
      headers: { authorization: `Bearer ${token}` },
      payload: { stars: 6 },
    });
    expect(res.statusCode).toBe(400);

    await prisma.user.delete({ where: { id: rider.id } });
  });

  it("404s for an unknown ride", async () => {
    const rider = await createTestUser("RIDER");
    const token = signAccessToken({ userId: rider.id, role: "RIDER" });

    const res = await app.inject({
      method: "POST",
      url: "/ratings",
      headers: { authorization: `Bearer ${token}` },
      payload: { rideId: "nonexistent", stars: 5 },
    });
    expect(res.statusCode).toBe(404);

    await prisma.user.delete({ where: { id: rider.id } });
  });

  it("403s for a rider who wasn't part of the ride", async () => {
    const { ride } = await createTestRide({ type: "LONE", status: "COMPLETED" });
    createdRideIds.push(ride.id);

    const rider = await createTestUser("RIDER");
    const token = signAccessToken({ userId: rider.id, role: "RIDER" });

    const res = await app.inject({
      method: "POST",
      url: "/ratings",
      headers: { authorization: `Bearer ${token}` },
      payload: { rideId: ride.id, stars: 5 },
    });
    expect(res.statusCode).toBe(403);

    await prisma.user.delete({ where: { id: rider.id } });
  });

  it("409s if the ride isn't COMPLETED", async () => {
    const { ride, rider } = await createTestRide({ type: "LONE", status: "REQUESTED" });
    createdRideIds.push(ride.id);
    const token = signAccessToken({ userId: rider.id, role: "RIDER" });

    const res = await app.inject({
      method: "POST",
      url: "/ratings",
      headers: { authorization: `Bearer ${token}` },
      payload: { rideId: ride.id, stars: 5 },
    });
    expect(res.statusCode).toBe(409);
  });

  it("409s if the ride has no driver", async () => {
    const { ride, rider } = await createTestRide({ type: "LONE", status: "COMPLETED" });
    createdRideIds.push(ride.id);
    const token = signAccessToken({ userId: rider.id, role: "RIDER" });

    const res = await app.inject({
      method: "POST",
      url: "/ratings",
      headers: { authorization: `Bearer ${token}` },
      payload: { rideId: ride.id, stars: 5 },
    });
    expect(res.statusCode).toBe(409);
  });

  it("creates a rating and upserts on a second submission", async () => {
    const { user: driverUser, driver } = await createTestDriver();
    createdDriverUserIds.push(driverUser.id);

    const { ride, rider } = await createTestRide({
      type: "LONE",
      status: "COMPLETED",
      driverId: driverUser.id,
    });
    createdRideIds.push(ride.id);
    void driver;

    const token = signAccessToken({ userId: rider.id, role: "RIDER" });

    const first = await app.inject({
      method: "POST",
      url: "/ratings",
      headers: { authorization: `Bearer ${token}` },
      payload: { rideId: ride.id, stars: 4, comment: "Smooth ride" },
    });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json();
    expect(firstBody.rating.stars).toBe(4);
    expect(firstBody.rating.rateeId).toBe(driverUser.id);

    const second = await app.inject({
      method: "POST",
      url: "/ratings",
      headers: { authorization: `Bearer ${token}` },
      payload: { rideId: ride.id, stars: 5 },
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().rating.stars).toBe(5);
    expect(second.json().rating.id).toBe(firstBody.rating.id);
  });
});

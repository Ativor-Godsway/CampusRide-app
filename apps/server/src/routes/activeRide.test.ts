import { describe, it, expect, afterEach, afterAll, beforeAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { PassengerStatus, RideStatus, RideType } from "@rida/shared";
import { prisma } from "../db/prisma";
import { registerRideRoutes } from "./rides";
import { signAccessToken } from "../services/auth/tokens";
import { findActiveRideForRider } from "../services/ride/activeRide";
import {
  cleanupRide,
  createTestRide,
  createTestUser,
  getTestZones,
} from "../services/ride/testFixtures";

/**
 * "Where is this rider's ride?" must always have an answer while a ride is
 * going on — including for a rider merged into someone else's car — and the
 * create-ride conflict must say which ride is in the way.
 */
let app: FastifyInstance;
const rideIds: string[] = [];
const userIds: string[] = [];

beforeAll(async () => {
  app = Fastify();
  registerRideRoutes(app, prisma);
  await app.ready();
});

afterEach(async () => {
  while (rideIds.length > 0) await cleanupRide(rideIds.pop()!);
  if (userIds.length > 0)
    await prisma.user.deleteMany({ where: { id: { in: userIds.splice(0) } } });
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

/** A ride requested by a fresh rider, who also holds a seat on it (as createRide does). */
async function requestedRide(
  status: RideStatus,
  type: RideType = "SHARED",
  seat: PassengerStatus = "WAITING",
) {
  const { ride, rider } = await createTestRide({ type, status });
  rideIds.push(ride.id);
  await prisma.ridePassenger.create({
    data: {
      rideId: ride.id,
      riderId: rider.id,
      pickupZoneId: ride.pickupZoneId,
      dropoffZoneId: ride.dropoffZoneId,
      status: seat,
      lockedFare: 500,
    },
  });
  return { ride, rider, token: signAccessToken({ userId: rider.id, role: "RIDER" }) };
}

function getActive(token: string) {
  return app.inject({
    method: "GET",
    url: "/rides/active",
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("findActiveRideForRider", () => {
  it.each(["REQUESTED", "AWAITING_RIDER_DECISION", "MATCHED", "ARRIVED", "IN_PROGRESS"] as const)(
    "finds the rider's own %s ride",
    async (status) => {
      const { ride, rider } = await requestedRide(status);
      const found = await findActiveRideForRider(prisma, rider.id);
      expect(found?.ride.id).toBe(ride.id);
    },
  );

  it.each(["COMPLETED", "CANCELLED"] as const)("ignores a %s ride", async (status) => {
    const { rider } = await requestedRide(status);
    expect(await findActiveRideForRider(prisma, rider.id)).toBeNull();
  });

  it("finds a rider MERGED into another car, via their seat on the anchor ride", async () => {
    const { ride: anchor } = await requestedRide("MATCHED");
    const { pickup, dropoff } = await getTestZones();
    // Their own request ride was closed as MERGED_INTO_ANOTHER_RIDE; all
    // that ties them to a live ride now is a seat on the anchor, whose
    // riderId is somebody else. (The closed request isn't needed here.)
    const merged = await createTestUser("RIDER");
    await prisma.ridePassenger.create({
      data: {
        rideId: anchor.id,
        riderId: merged.id,
        pickupZoneId: dropoff.id,
        dropoffZoneId: pickup.id,
        status: "WAITING",
        lockedFare: 500,
      },
    });

    const found = await findActiveRideForRider(prisma, merged.id);
    expect(found?.ride.id).toBe(anchor.id);
    expect(found?.passenger?.riderId).toBe(merged.id);

    // And the endpoint reports THEIR leg's zones, not the anchor rider's.
    const res = await getActive(signAccessToken({ userId: merged.id, role: "RIDER" }));
    expect(res.json().ride).toMatchObject({
      id: anchor.id,
      pickupZone: { id: dropoff.id },
      dropoffZone: { id: pickup.id },
    });
  });

  it("does not count a ride on which the rider's own seat was cancelled", async () => {
    const { rider } = await requestedRide("MATCHED", "SHARED", "CANCELLED");
    expect(await findActiveRideForRider(prisma, rider.id)).toBeNull();
  });

  it("still counts the ride after the requester is dropped off, until it completes (fare + rating)", async () => {
    const { ride, rider } = await requestedRide("IN_PROGRESS", "SHARED", "DROPPED_OFF");
    expect((await findActiveRideForRider(prisma, rider.id))?.ride.id).toBe(ride.id);
  });
});

describe("GET /rides/active", () => {
  it("requires a login", async () => {
    expect((await app.inject({ method: "GET", url: "/rides/active" })).statusCode).toBe(401);
  });

  it("answers { ride: null } when nothing is going on", async () => {
    const rider = await createTestUser("RIDER");
    userIds.push(rider.id);
    const res = await getActive(signAccessToken({ userId: rider.id, role: "RIDER" }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ride: null });
  });

  it("returns what the app needs to show the banner and reopen the ride", async () => {
    const { ride, token } = await requestedRide("REQUESTED", "LONE");
    const res = await getActive(token);
    expect(res.statusCode).toBe(200);
    expect(res.json().ride).toMatchObject({
      id: ride.id,
      status: "REQUESTED",
      type: "LONE",
      legStatus: "WAITING",
      pickupZone: { id: ride.pickupZoneId },
      dropoffZone: { id: ride.dropoffZoneId },
      driver: null,
    });
    expect(res.json().ride.pickupZone).toHaveProperty("latitude");
  });

  it("names the driver by first name only once one is assigned", async () => {
    const driver = await createTestUser("DRIVER");
    await prisma.user.update({ where: { id: driver.id }, data: { name: "Kofi Mensah" } });
    const { ride, token } = await requestedRide("MATCHED");
    await prisma.ride.update({ where: { id: ride.id }, data: { driverId: driver.id } });

    const res = await getActive(token);
    expect(res.json().ride.driver).toEqual({ firstName: "Kofi" });
  });
});

describe("POST /rides while a ride is going on", () => {
  it("answers 409 with the active ride's id, and no longer leaks the whole ride row", async () => {
    const { ride, token } = await requestedRide("REQUESTED");
    const { pickup, dropoff } = await getTestZones();
    const res = await app.inject({
      method: "POST",
      url: "/rides",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        pickupZoneId: pickup.id,
        dropoffZoneId: dropoff.id,
        type: "LONE",
        paymentMethod: "CASH",
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: expect.any(String),
      code: "ACTIVE_RIDE_EXISTS",
      activeRideId: ride.id,
      ride: { id: ride.id, status: "REQUESTED" },
    });
  });

  it("also refuses a MERGED rider, who used to be able to book a second ride mid-trip", async () => {
    const { ride: anchor } = await requestedRide("MATCHED");
    const { pickup, dropoff } = await getTestZones();
    const merged = await createTestUser("RIDER");
    await prisma.ridePassenger.create({
      data: {
        rideId: anchor.id,
        riderId: merged.id,
        pickupZoneId: pickup.id,
        dropoffZoneId: dropoff.id,
        status: "PICKED_UP",
        lockedFare: 500,
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/rides",
      headers: { authorization: `Bearer ${signAccessToken({ userId: merged.id, role: "RIDER" })}` },
      payload: {
        pickupZoneId: pickup.id,
        dropoffZoneId: dropoff.id,
        type: "LONE",
        paymentMethod: "CASH",
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().activeRideId).toBe(anchor.id);
  });
});

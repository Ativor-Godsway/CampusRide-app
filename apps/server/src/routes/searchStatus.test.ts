/**
 * The rider's "Finding your driver" screen (GET /rides/:id/search-status,
 * services/ride/searchStatus.ts). Pins:
 *   1. every number is what dispatch really did: drivers offered and still
 *      holding it (a decline takes one away), nearby or campus-wide, the
 *      live cars looked at, the nearest free-seat car to 100 m;
 *   2. busy drivers nearby or elsewhere, and "first in line" only when no
 *      request near the pickup has waited longer;
 *   3. "usually X–Y min" from the last 7 days' real accepts (median to 75th
 *      percentile), none with too few, review demo rides left out;
 *   4. private: no driver id anywhere in it, map cars blurred as on Home;
 *   5. only the booking rider (404 for anyone else), `status: null` once
 *      the ride stops searching, and a restart still gives real counts;
 *   6. older rider apps: GET /rides/nearby-cars still has no cars for a
 *      rider whose request is searching.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { Zone } from "@prisma/client";
import { NEARBY_CARS_PATH, haversineDistanceMeters, type LatLng, type RideSearchStatus } from "@rida/shared";
import { prisma } from "../db/prisma";
import { registerRideRoutes } from "./rides";
import { signAccessToken } from "../services/auth/tokens";
import { broadcastRide } from "../services/ride/dispatch";
import { recordOfferAnswer } from "../services/stats/rideOffers";
import { cleanupRide, createTestDriver, createTestRide, createTestUser, createZoneAdjacency } from "../services/ride/testFixtures";
import { recordDriverPosition, resetLivePositionsForTests } from "../services/zones/livePositions";
import { resetNearbyCarsForTests } from "../services/ride/nearbyCars";
import { resetSearchProgressForTests } from "../services/ride/searchProgress";
import { resetSearchStatusForTests, usualWait } from "../services/ride/searchStatus";
import { setWaitFeeSettingsForTests } from "../services/ride/waitFee";

const MARK = `search-status-${Date.now()}`;
/** On campus (as nearbyCars.test.ts): the pickup pin. */
const PICKUP = { latitude: 5.65201, longitude: -0.18705 };
const METERS_PER_DEGREE = 111_320;
/** A point `meters` north of the pickup. */
const north = (meters: number): LatLng => ({ latitude: PICKUP.latitude + meters / METERS_PER_DEGREE, longitude: PICKUP.longitude });
/** Across campus (about 1.1 km south). */
const NIGHT_MARKET = { latitude: 5.64208, longitude: -0.1856 };

let app: FastifyInstance;
let zones: { a: Zone; b: Zone; c: Zone };
const userIds: string[] = [];
const rideIds: string[] = [];
let rowsBefore: string[] = [];
let onlineBefore: string[] = [];

beforeAll(async () => {
  app = Fastify();
  registerRideRoutes(app, prisma);
  await app.ready();
});

beforeEach(async () => {
  resetLivePositionsForTests();
  resetNearbyCarsForTests();
  resetSearchProgressForTests();
  resetSearchStatusForTests();
  setWaitFeeSettingsForTests();
  // Only this file's drivers are online (rows other files left behind are set aside).
  onlineBefore = (await prisma.driver.findMany({ where: { isOnline: true }, select: { userId: true } })).map((d) => d.userId);
  await prisma.driver.updateMany({ where: { userId: { in: onlineBefore } }, data: { isOnline: false } });
  rowsBefore = (await prisma.zoneAdjacency.findMany({ select: { id: true } })).map((r) => r.id);
  const zone = (name: string, latitude: number) =>
    prisma.zone.create({ data: { name: `${MARK} ${name}`, quadrant: "CENTRAL", latitude, longitude: -0.187 } });
  // a = the pickup's zone, b next to it, c across campus.
  zones = { a: await zone("A", 5.652), b: await zone("B", 5.6525), c: await zone("C", 5.63) };
  await createZoneAdjacency(zones.a.id, zones.b.id);
});

afterEach(async () => {
  // Let fire-and-forget work from broadcasts (offer stats, the board) finish first.
  await new Promise((r) => setTimeout(r, 50));
  while (rideIds.length) await cleanupRide(rideIds.pop()!);
  const ids = userIds.splice(0);
  await prisma.ride.deleteMany({ where: { OR: [{ driverId: { in: ids } }, { riderId: { in: ids } }] } });
  await prisma.driver.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.zoneAdjacency.deleteMany({ where: { id: { notIn: rowsBefore } } });
  await prisma.zone.deleteMany({ where: { name: { startsWith: MARK } } });
  await prisma.driver.updateMany({ where: { userId: { in: onlineBefore } }, data: { isOnline: true } });
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

/** A live, approved, online driver in `zone`, whose app last reported `at`. */
async function driverIn(zone: Zone, at: LatLng | null) {
  const { user } = await createTestDriver({ isOnline: true, isApproved: true, currentZoneId: zone.id });
  userIds.push(user.id);
  if (at) recordDriverPosition(user.id, at);
  return user.id;
}

/** A request searching from the pickup pin in `zone`, booked by its own rider. */
async function request(zone: Zone, opts: { createdAt?: Date } = {}) {
  const { ride, rider } = await createTestRide({
    type: "LONE",
    pickupZoneId: zone.id,
    dropoffZoneId: zones.c.id,
    broadcastStartedAt: new Date(),
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
  });
  rideIds.push(ride.id);
  userIds.push(rider.id);
  await prisma.ride.update({ where: { id: ride.id }, data: { pickupLat: PICKUP.latitude, pickupLng: PICKUP.longitude } });
  await prisma.ridePassenger.create({
    data: { rideId: ride.id, riderId: rider.id, pickupZoneId: zone.id, dropoffZoneId: zones.c.id, status: "WAITING", lockedFare: 1500 },
  });
  return { rideId: ride.id, riderId: rider.id, token: signAccessToken({ userId: rider.id, role: "RIDER" }) };
}

/** Dispatch offers it, as POST /rides does; waits for the offer rows it writes. */
async function dispatch(rideId: string, expectOffers: number) {
  await broadcastRide(prisma, rideId);
  await vi.waitFor(async () => expect(await prisma.rideOffer.count({ where: { rideId } })).toBe(expectOffers));
}

async function statusFor(rideId: string, token: string): Promise<RideSearchStatus | null> {
  const res = await app.inject({ method: "GET", url: `/rides/${rideId}/search-status`, headers: { authorization: `Bearer ${token}` } });
  expect(res.statusCode).toBe(200);
  expect(res.headers["cache-control"]).toBe("no-store");
  return res.json().status;
}

describe("real counts", () => {
  it("shown to the drivers nearby, all still have it, the cars checked and the nearest free car", async () => {
    const near = await driverIn(zones.a, north(240));
    const next = await driverIn(zones.b, north(640));
    const far = await driverIn(zones.c, NIGHT_MARKET);
    const r = await request(zones.a);
    await dispatch(r.rideId, 2);

    const status = await statusFor(r.rideId, r.token);
    expect(status).toMatchObject({
      rideId: r.rideId,
      driversOffered: 2,
      driversWithIt: 2,
      scope: "nearby",
      // The two nearby drivers' cars (the far one isn't looked at: someone nearby is free).
      carsChecked: 2,
      // 240 m, to the nearest 100 m.
      nearestFreeCarMeters: 200,
      driversOnTrips: null,
      firstInLine: true,
      freeWaitSeconds: 150,
    });
    expect(Date.parse(status!.searchStartedAt!)).not.toBeNaN();
    // Every available car on the map, as the Home map has them.
    expect(status!.cars).toHaveLength(3);

    // Private: no driver id anywhere in it, and every car is blurred.
    const raw = JSON.stringify(status);
    for (const id of [near, next, far]) expect(raw).not.toContain(id);
    for (const car of status!.cars) {
      expect(Object.keys(car).sort()).toEqual(["heading", "key", "latitude", "longitude"]);
      const offsets = [north(240), north(640), NIGHT_MARKET].map((p) => haversineDistanceMeters(car, p));
      expect(Math.min(...offsets)).toBeGreaterThanOrEqual(9.5);
    }
  });

  it("a decline: that driver no longer has it, and isn't the nearest free car any more", async () => {
    const near = await driverIn(zones.a, north(240));
    await driverIn(zones.a, north(760));
    const r = await request(zones.a);
    await dispatch(r.rideId, 2);

    await recordOfferAnswer(prisma, r.rideId, near, "DECLINED");
    const status = await statusFor(r.rideId, r.token);
    expect(status).toMatchObject({ driversOffered: 2, driversWithIt: 1, nearestFreeCarMeters: 800 });
  });

  it("a pop-up that only ran out still counts: the request stays in that driver's list", async () => {
    const near = await driverIn(zones.a, north(240));
    const r = await request(zones.a);
    await dispatch(r.rideId, 1);
    await recordOfferAnswer(prisma, r.rideId, near, "TIMED_OUT");
    expect(await statusFor(r.rideId, r.token)).toMatchObject({ driversOffered: 1, driversWithIt: 1, nearestFreeCarMeters: 200 });
  });

  it("nobody free near the pickup: every live driver on campus, and it says so", async () => {
    await driverIn(zones.c, NIGHT_MARKET);
    await driverIn(zones.c, null);
    const r = await request(zones.a);
    await dispatch(r.rideId, 2);
    expect(await statusFor(r.rideId, r.token)).toMatchObject({ driversOffered: 2, driversWithIt: 2, scope: "campus", carsChecked: 2 });
  });

  it("no live driver anywhere: zeros, never invented, and no nearest car", async () => {
    const r = await request(zones.a);
    await broadcastRide(prisma, r.rideId);
    expect(await statusFor(r.rideId, r.token)).toMatchObject({
      driversOffered: 0,
      driversWithIt: 0,
      carsChecked: 0,
      nearestFreeCarMeters: null,
      cars: [],
    });
  });

  it("after a restart (nothing in memory), the counts are dispatch's rules now — the drivers' lists", async () => {
    await driverIn(zones.a, north(240));
    await driverIn(zones.b, north(500));
    const r = await request(zones.a);
    // Never broadcast by this server.
    expect(await statusFor(r.rideId, r.token)).toMatchObject({ driversOffered: 2, driversWithIt: 2, scope: "nearby", carsChecked: 2 });
  });
});

describe("drivers on trips, first in line", () => {
  async function busyDriverIn(zone: Zone) {
    const id = await driverIn(zone, null);
    const busy = await createTestRide({ type: "LONE", status: "MATCHED", driverId: id, pickupZoneId: zone.id, dropoffZoneId: zones.c.id });
    rideIds.push(busy.ride.id);
    userIds.push(busy.rider.id);
    return id;
  }

  it("a driver busy on a trip near the pickup: nearby; elsewhere: on campus", async () => {
    await busyDriverIn(zones.b);
    const r = await request(zones.a);
    expect((await statusFor(r.rideId, r.token))!.driversOnTrips).toBe("nearby");

    await prisma.driver.updateMany({ where: { userId: { in: userIds } }, data: { currentZoneId: zones.c.id } });
    resetSearchStatusForTests();
    expect((await statusFor(r.rideId, r.token))!.driversOnTrips).toBe("campus");
  });

  it("first in line only while no request near the pickup has waited longer", async () => {
    const older = await request(zones.b, { createdAt: new Date(Date.now() - 60_000) });
    const mine = await request(zones.a);
    expect((await statusFor(mine.rideId, mine.token))!.firstInLine).toBe(false);
    expect((await statusFor(older.rideId, older.token))!.firstInLine).toBe(true);
    // A request across campus doesn't count.
    await prisma.ride.update({ where: { id: older.rideId }, data: { pickupZoneId: zones.c.id } });
    expect((await statusFor(mine.rideId, mine.token))!.firstInLine).toBe(true);
  });
});

describe("usually X–Y min", () => {
  // A week of its own, far from any other test's rows.
  const NOW = Date.parse("2099-01-08T12:00:00Z");

  async function accepted(minutesAgo: number, secondsToAccept: number, opts: { demo?: boolean } = {}) {
    const createdAt = new Date(NOW - minutesAgo * 60_000);
    const { ride, rider } = await createTestRide({ type: "LONE", status: "COMPLETED", createdAt });
    rideIds.push(ride.id);
    userIds.push(rider.id);
    await prisma.ride.update({
      where: { id: ride.id },
      data: { matchedAt: new Date(createdAt.getTime() + secondsToAccept * 1000), isReviewDemo: opts.demo ?? false },
    });
  }

  it("too few accepts in the last 7 days: no estimate", async () => {
    for (const s of [60, 90, 120, 200]) await accepted(100, s);
    expect(await usualWait(prisma, NOW)).toBeNull();
  });

  it("median to 75th percentile, in whole minutes; review demo and older than 7 days left out", async () => {
    for (const s of [60, 90, 100, 120, 200, 300]) await accepted(100, s);
    await accepted(100, 5_000, { demo: true });
    await accepted(8 * 24 * 60, 5_000);
    // Median 110 s → 2 min; 75th percentile 180 s → 3 min.
    expect(await usualWait(prisma, NOW)).toEqual({ fromMinutes: 2, toMinutes: 3 });
  });
});

describe("who may ask, and when", () => {
  it("only the booking rider; drivers 403; status null once it stops searching", async () => {
    const r = await request(zones.a);
    const other = await createTestUser("RIDER");
    userIds.push(other.id);
    const as = (token: string) =>
      app.inject({ method: "GET", url: `/rides/${r.rideId}/search-status`, headers: { authorization: `Bearer ${token}` } });

    expect((await as(signAccessToken({ userId: other.id, role: "RIDER" }))).statusCode).toBe(404);
    const d = await driverIn(zones.a, null);
    expect((await as(signAccessToken({ userId: d, role: "DRIVER" }))).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: `/rides/${r.rideId}/search-status` })).statusCode).toBe(401);

    await prisma.ride.update({ where: { id: r.rideId }, data: { status: "MATCHED", driverId: d } });
    expect(await statusFor(r.rideId, r.token)).toBeNull();
  });

  it("older rider apps: the Home cars route still shows no cars to a rider whose request is searching", async () => {
    await driverIn(zones.a, north(240));
    const r = await request(zones.a);
    const res = await app.inject({ method: "GET", url: NEARBY_CARS_PATH, headers: { authorization: `Bearer ${r.token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ cars: [] });
  });
});

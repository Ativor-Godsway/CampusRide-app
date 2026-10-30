/**
 * The cars on the rider's Home map (GET /rides/nearby-cars). Pins:
 *   1. only riders can ask;
 *   2. a car is a short-lived key, a position and a heading — never who
 *      drives it — and the position is blurred by 10-25 m;
 *   3. offline, unapproved, stale, off-campus, full, review demo and closed
 *      accounts' cars are left out; a shared car with a free seat shows;
 *   4. at most 20 cars, nearest first; none for a rider with a ride going on;
 *   5. the per-account limit;
 *   6. an idle driver's socket position is what feeds it (memory only).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  NEARBY_CARS_MAX,
  NEARBY_CARS_PATH,
  NEARBY_CAR_FRESH_MS,
  NEARBY_CAR_KEY_MS,
  haversineDistanceMeters,
  type LatLng,
  type NearbyCar,
} from "@rida/shared";
import { prisma } from "../db/prisma";
import { installRateLimits } from "../rateLimit/http";
import { setRateLimitStore } from "../rateLimit/limiter";
import { MemoryRateLimitStore } from "../rateLimit/store";
import { RULES } from "../rateLimit/rules";
import { registerRideRoutes } from "./rides";
import { signAccessToken } from "../services/auth/tokens";
import { createTestDriver, createTestUser, getTestZones } from "../services/ride/testFixtures";
import { recordDriverPosition, resetLivePositionsForTests } from "../services/zones/livePositions";
import { nearbyCars, resetNearbyCarsForTests } from "../services/ride/nearbyCars";

// On campus (the same points as exactPins.test.ts), and off it.
const BALME = { latitude: 5.65201, longitude: -0.18705 };
const VOLTA = { latitude: 5.6515, longitude: -0.18969 };
const NIGHT_MARKET = { latitude: 5.64208, longitude: -0.1856 };
const ACCRA_MALL = { latitude: 5.62218, longitude: -0.17326 };

let app: FastifyInstance;
const userIds: string[] = [];

beforeAll(async () => {
  app = Fastify();
  installRateLimits(app);
  registerRideRoutes(app, prisma);
  await app.ready();
});

beforeEach(() => {
  setRateLimitStore(new MemoryRateLimitStore(1000, 0));
  resetLivePositionsForTests();
  resetNearbyCarsForTests();
});

afterEach(async () => {
  const ids = userIds.splice(0);
  const rides = await prisma.ride.findMany({
    where: { OR: [{ riderId: { in: ids } }, { driverId: { in: ids } }] },
    select: { id: true },
  });
  await prisma.ride.deleteMany({ where: { id: { in: rides.map((r) => r.id) } } });
  await prisma.driver.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

async function rider() {
  const user = await createTestUser("RIDER");
  userIds.push(user.id);
  return { user, token: signAccessToken({ userId: user.id, role: "RIDER" }) };
}

/** An approved, online driver whose app reported `at` (default: just now). */
async function driver(at: LatLng, opts: { isOnline?: boolean; isApproved?: boolean; ageMs?: number } = {}) {
  const { user, driver: row } = await createTestDriver({ isOnline: opts.isOnline ?? true, isApproved: opts.isApproved ?? true });
  userIds.push(user.id);
  recordDriverPosition(user.id, at, Date.now() - (opts.ageMs ?? 0));
  return { user, driver: row };
}

function ask(token: string, near?: LatLng) {
  const query = near ? `?latitude=${near.latitude}&longitude=${near.longitude}` : "";
  return app.inject({ method: "GET", url: `${NEARBY_CARS_PATH}${query}`, headers: { authorization: `Bearer ${token}` } });
}

async function cars(token: string, near?: LatLng): Promise<NearbyCar[]> {
  const res = await ask(token, near);
  expect(res.statusCode).toBe(200);
  return res.json().cars;
}

/** A trip this driver is on, with these seats taken. */
async function trip(driverId: string, type: "LONE" | "SHARED", seatsTaken: number) {
  const { pickup, dropoff } = await getTestZones();
  const riders = await Promise.all(Array.from({ length: seatsTaken }, () => rider()));
  await prisma.ride.create({
    data: {
      riderId: riders[0]!.user.id,
      driverId,
      type,
      status: "MATCHED",
      pickupZoneId: pickup.id,
      dropoffZoneId: dropoff.id,
      occupancy: seatsTaken,
      broadcastStartedAt: new Date(),
      passengers: {
        create: riders.map((r) => ({
          riderId: r.user.id,
          pickupZoneId: pickup.id,
          dropoffZoneId: dropoff.id,
          status: "WAITING" as const,
          lockedFare: 500,
        })),
      },
    },
  });
}

/** Distance from a car to where its driver really is. */
const offsetOf = (car: NearbyCar, at: LatLng) => haversineDistanceMeters(car, at);

describe("who can ask", () => {
  it("riders only: no token 401, drivers and admins 403", async () => {
    expect((await app.inject({ method: "GET", url: NEARBY_CARS_PATH })).statusCode).toBe(401);
    const d = await driver(BALME);
    expect((await ask(signAccessToken({ userId: d.user.id, role: "DRIVER" }))).statusCode).toBe(403);
    const adminUser = await createTestUser("RIDER");
    userIds.push(adminUser.id);
    await prisma.user.update({ where: { id: adminUser.id }, data: { role: "ADMIN" } });
    expect((await ask(signAccessToken({ userId: adminUser.id, role: "ADMIN" }))).statusCode).toBe(403);
  });
});

describe("what a car says", () => {
  it("a key, a blurred position and a heading — nothing about the driver", async () => {
    const { token } = await rider();
    const d = await driver(BALME);
    // It moved north-east: a heading.
    recordDriverPosition(d.user.id, { latitude: BALME.latitude + 0.0003, longitude: BALME.longitude + 0.0003 });
    const res = await ask(token, BALME);
    const body = res.json();
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(body.cars).toHaveLength(1);
    const [car] = body.cars as NearbyCar[];
    expect(Object.keys(car!).sort()).toEqual(["heading", "key", "latitude", "longitude"]);
    expect(car!.heading).toBeGreaterThan(30);
    expect(car!.heading).toBeLessThan(60);

    const text = JSON.stringify(body);
    for (const secret of [d.user.id, d.driver.id, d.user.name, d.user.phone, d.driver.plate!, d.user.phone.slice(4)]) {
      expect(text).not.toContain(secret);
    }

    const real = { latitude: BALME.latitude + 0.0003, longitude: BALME.longitude + 0.0003 };
    expect(offsetOf(car!, real)).toBeGreaterThanOrEqual(9.5);
    expect(offsetOf(car!, real)).toBeLessThanOrEqual(25.5);
  });

  it("the same key and offset within a few minutes (smooth), new ones after", async () => {
    const { user } = await rider();
    const d = await driver(BALME);
    const windowStart = Math.floor(Date.now() / NEARBY_CAR_KEY_MS) * NEARBY_CAR_KEY_MS;
    const at = (t: number) => nearbyCars(prisma, user.id, null, t);

    recordDriverPosition(d.user.id, BALME, windowStart + 1000);
    const [first] = await at(windowStart + 1000);
    recordDriverPosition(d.user.id, VOLTA, windowStart + 6000);
    const [moved] = await at(windowStart + 6000);
    expect(moved!.key).toBe(first!.key);
    // The car moved exactly as far as the driver did: the offset is fixed.
    expect(haversineDistanceMeters(first!, moved!)).toBeCloseTo(haversineDistanceMeters(BALME, VOLTA), 0);

    recordDriverPosition(d.user.id, VOLTA, windowStart + NEARBY_CAR_KEY_MS + 1000);
    const [later] = await at(windowStart + NEARBY_CAR_KEY_MS + 1000);
    expect(later!.key).not.toBe(first!.key);
  });
});

describe("which cars show", () => {
  it("leaves out offline, unapproved, stale, off-campus, full, review demo and closed accounts' cars", async () => {
    const { token } = await rider();
    const shown = await driver(BALME);
    await driver(VOLTA, { isOnline: false });
    await driver(VOLTA, { isApproved: false });
    await driver(VOLTA, { ageMs: NEARBY_CAR_FRESH_MS + 1000 });
    await driver(ACCRA_MALL);
    const lone = await driver(NIGHT_MARKET);
    await trip(lone.user.id, "LONE", 1);
    const fullShared = await driver(NIGHT_MARKET);
    await trip(fullShared.user.id, "SHARED", 4);
    const roomShared = await driver(NIGHT_MARKET);
    await trip(roomShared.user.id, "SHARED", 2);
    const demo = await driver(VOLTA);
    await prisma.user.update({ where: { id: demo.user.id }, data: { isReviewDemo: true } });
    const closed = await driver(VOLTA);
    await prisma.user.update({ where: { id: closed.user.id }, data: { deletedAt: new Date() } });
    // Another test file's drivers may be online in the test database: only
    // this test's positions are in memory, so only these can show.

    const result = await cars(token, BALME);
    expect(result).toHaveLength(2);
    const nearest = result[0]!;
    expect(offsetOf(nearest, BALME)).toBeLessThanOrEqual(25.5);
    expect(offsetOf(result[1]!, NIGHT_MARKET)).toBeLessThanOrEqual(25.5);
    expect(shown).toBeTruthy();
  });

  it("at most 20, the nearest to the point asked about first", async () => {
    const { token } = await rider();
    // 25 cars in a line going south from Balme, 50 m apart.
    for (let i = 0; i < NEARBY_CARS_MAX + 5; i++) {
      await driver({ latitude: BALME.latitude - i * 0.00045, longitude: BALME.longitude });
    }
    const result = await cars(token, BALME);
    expect(result).toHaveLength(NEARBY_CARS_MAX);
    const distances = result.map((c) => haversineDistanceMeters(c, BALME));
    expect([...distances].sort((a, b) => a - b)).toEqual(distances);
    // The 5 furthest (over 1 km south) were the ones left out.
    expect(Math.max(...distances)).toBeLessThan(20 * 50 + 30);
  });

  it("none for a rider with a ride going on: they follow their own driver", async () => {
    const r = await rider();
    await driver(BALME);
    const { pickup, dropoff } = await getTestZones();
    await prisma.ride.create({
      data: {
        riderId: r.user.id,
        type: "SHARED",
        status: "REQUESTED",
        pickupZoneId: pickup.id,
        dropoffZoneId: dropoff.id,
        occupancy: 1,
        broadcastStartedAt: new Date(),
        passengers: {
          create: [{ riderId: r.user.id, pickupZoneId: pickup.id, dropoffZoneId: dropoff.id, status: "WAITING", lockedFare: 500 }],
        },
      },
    });
    expect(await cars(r.token, BALME)).toEqual([]);
  });

  it("nobody heard from: an empty list, not an error", async () => {
    const { token } = await rider();
    expect(await cars(token)).toEqual([]);
  });
});

describe("the limit", () => {
  it("refuses past the per-account allowance, with Retry-After", async () => {
    const { token } = await rider();
    for (let i = 0; i < RULES.nearbyCars.max; i++) expect((await ask(token)).statusCode).toBe(200);
    const refused = await ask(token);
    expect(refused.statusCode).toBe(429);
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
    expect(Number(refused.headers["retry-after"])).toBeLessThanOrEqual(5);
    // Its own allowance: the account's default limit is untouched.
    const other = await rider();
    expect((await ask(other.token)).statusCode).toBe(200);
  });
});

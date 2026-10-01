/**
 * Database round trips per driver action.
 *
 * Every query is a network round trip to the database, and they run one
 * after another. From a server near the database that is ~5 ms each; from a
 * laptop on a phone hotspot talking to Neon in the US it measured ~1.4 s
 * each, which turned a 15-query drop-off into a 20 s request that the app gave
 * up on ("Couldn't drop off — reverted"). The fix was to cut the count; this
 * test keeps it cut. If a change needs more queries, raise the budget
 * deliberately and say why.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";
import { config } from "../config";
import { prisma } from "../db/prisma";
import { registerDriverRoutes } from "./driver";
import { signAccessToken } from "../services/auth/tokens";
import { forceZoneCacheForTests } from "../services/zones/zoneCache";
import {
  cleanupDriver,
  createTestDriver,
  createTestRide,
  createTestUser,
  getThreeTestZones,
} from "../services/ride/testFixtures";

/**
 * Round-trip ceilings, per endpoint — what the driver waits for, i.e. every
 * query before the reply. Measured 2026-10-01 (before → after this change):
 * eligible 6→3, claim 9→2, active 7→4, fill-suggestions 10→3, add 16→7,
 * arrived 11→6, pickup 15→6, cancel 12→6, drop-off 11→5, last drop-off 21→6.
 * A passenger action is BEGIN, lock ride, read seats, write seat, write ride,
 * COMMIT. "active" is 3 on a real ride; this fixture's owner has no seat, so
 * it reads the owner separately. add-preview (added later) runs its reads
 * in parallel: the car, its seats, their names, the request, its rider.
 * eligible / fill-suggestions / add-preview each gained one read (2026-10-03)
 * for the requesting rider's first name, so the trip never says "Your rider".
 */
const BUDGET = {
  "GET /driver/rides/active": 4,
  "GET /driver/rides/eligible": 4,
  "GET /rides/:id/fill-suggestions": 4,
  "GET /rides/:id/add-preview": 5,
  "POST /rides/:id/claim": 2,
  "POST /rides/:id/add-passenger": 7,
  "POST passenger arrived": 6,
  "POST passenger pickup": 6,
  "POST passenger dropoff (not last)": 5,
  "POST passenger dropoff (last, completes ride)": 6,
  "POST passenger cancel": 6,
} as const;

type Endpoint = keyof typeof BUDGET;

let counted = 0;
const counting = new PrismaClient({
  datasources: { db: { url: config.databaseUrl } },
  log: [{ emit: "event", level: "query" }],
});
counting.$on("query", () => {
  counted += 1;
});

let app: FastifyInstance;
const measured: Partial<Record<Endpoint, number>> = {};
const rideIds: string[] = [];
const driverIds: string[] = [];

beforeAll(async () => {
  // Measure what a running server does: zones and adjacency come from memory.
  forceZoneCacheForTests(counting);
  app = Fastify();
  registerDriverRoutes(app, counting);
  await app.ready();
});

afterAll(async () => {
  // Rides merged into one another share riders, so remove every seat and
  // ride first, then the people.
  const rides = await prisma.ride.findMany({ where: { id: { in: rideIds } }, include: { passengers: true } });
  const userIds = new Set(rides.flatMap((r) => [r.riderId, ...r.passengers.map((p) => p.riderId)]));
  await prisma.ridePassenger.deleteMany({ where: { rideId: { in: rideIds } } });
  await prisma.commissionLedger.deleteMany({ where: { rideId: { in: rideIds } } });
  await prisma.ride.updateMany({ where: { id: { in: rideIds } }, data: { mergedIntoRideId: null } });
  await prisma.ride.deleteMany({ where: { id: { in: rideIds } } });
  await prisma.user.deleteMany({ where: { id: { in: [...userIds] } } });
  for (const id of driverIds) await cleanupDriver(id);
  await app.close();
  await counting.$disconnect();
  const lines = Object.entries(measured).map(
    ([endpoint, queries]) => `  ${String(queries).padStart(3)} / ${BUDGET[endpoint as Endpoint]}  ${endpoint}`,
  );
  console.log(`ROUND TRIPS (queries / budget)\n${lines.join("\n")}`);
});

async function measure(endpoint: Endpoint, method: "GET" | "POST", url: string, token: string, payload?: object) {
  counted = 0;
  const res = await app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });
  // What the driver waits for is everything before the reply. Work done
  // after it (telling riders, the commission ledger) is not counted, but it
  // must finish before the next measurement starts.
  measured[endpoint] = counted;
  await new Promise((r) => setTimeout(r, 100));
  return res;
}

describe("driver endpoint round trips", () => {
  it("stay within budget through a whole shared trip", async () => {
    const { pickup, adjacent } = await getThreeTestZones();
    const { user: driver } = await createTestDriver({ isOnline: true, isApproved: true, currentZoneId: pickup.id });
    driverIds.push(driver.id);
    const token = signAccessToken({ userId: driver.id, role: "DRIVER" });

    // Three open Shared requests at the driver's zone.
    const requests: Awaited<ReturnType<typeof createTestRide>>["ride"][] = [];
    for (let i = 0; i < 3; i++) {
      const rider = await createTestUser("RIDER");
      const { ride } = await createTestRide({
        type: "SHARED",
        status: "REQUESTED",
        pickupZoneId: pickup.id,
        dropoffZoneId: adjacent.id,
        broadcastStartedAt: new Date(),
        passengers: [{ riderId: rider.id, lockedFare: 500 }],
      });
      rideIds.push(ride.id);
      requests.push(ride);
    }
    const [anchor, second, third] = requests as [typeof requests[number], typeof requests[number], typeof requests[number]];

    // Warm any caches, as a running server would be.
    await measure("GET /driver/rides/eligible", "GET", "/driver/rides/eligible", token);
    expect((await measure("GET /driver/rides/eligible", "GET", "/driver/rides/eligible", token)).statusCode).toBe(200);

    expect((await measure("POST /rides/:id/claim", "POST", `/rides/${anchor.id}/claim`, token)).statusCode).toBe(200);
    expect((await measure("GET /driver/rides/active", "GET", "/driver/rides/active", token)).statusCode).toBe(200);
    expect(
      (await measure("GET /rides/:id/fill-suggestions", "GET", `/rides/${anchor.id}/fill-suggestions`, token)).statusCode,
    ).toBe(200);

    expect(
      (await measure("GET /rides/:id/add-preview", "GET", `/rides/${anchor.id}/add-preview?requestRideId=${second.id}`, token)).statusCode,
    ).toBe(200);

    for (const req of [second, third]) {
      const res = await measure("POST /rides/:id/add-passenger", "POST", `/rides/${anchor.id}/add-passenger`, token, {
        requestRideId: req.id,
      });
      expect(res.statusCode).toBe(200);
    }

    const seats = await prisma.ridePassenger.findMany({ where: { rideId: anchor.id }, orderBy: { createdAt: "asc" } });
    expect(seats).toHaveLength(3);
    const [a, b, c] = seats as [typeof seats[number], typeof seats[number], typeof seats[number]];
    const seat = (id: string, action: string) => `/rides/${anchor.id}/passengers/${id}/${action}`;

    expect((await measure("POST passenger arrived", "POST", seat(a.id, "arrived"), token)).statusCode).toBe(200);
    expect((await measure("POST passenger pickup", "POST", seat(a.id, "pickup"), token)).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: seat(b.id, "arrived"), headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: seat(b.id, "pickup"), headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
    expect((await measure("POST passenger cancel", "POST", seat(c.id, "cancel"), token)).statusCode).toBe(200);
    expect((await measure("POST passenger dropoff (not last)", "POST", seat(a.id, "dropoff"), token)).statusCode).toBe(200);
    expect(
      (await measure("POST passenger dropoff (last, completes ride)", "POST", seat(b.id, "dropoff"), token)).statusCode,
    ).toBe(200);

    const done = await prisma.ride.findUniqueOrThrow({ where: { id: anchor.id } });
    expect(done.status).toBe("COMPLETED");

    for (const [endpoint, queries] of Object.entries(measured)) {
      expect(queries, endpoint).toBeLessThanOrEqual(BUDGET[endpoint as Endpoint]);
    }
  });
});

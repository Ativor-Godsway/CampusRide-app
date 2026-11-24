/**
 * Far-trip pricing and refused bookings (2026-11-24). Pins:
 *   1. two far ends: a Shared seat is GH₵9 ONLY from the north end to the
 *      south end or back; main campus ↔ either end, inside one end and main
 *      campus ↔ main campus are GH₵7; Ride alone is GH₵15 everywhere;
 *   2. a pin with no place chosen counts by the place it's near (≤ 250 m);
 *   3. the price is locked when the request is made: the quote, the seat, a
 *      Shared/Ride alone switch and the driver's offer (85% share) agree; an
 *      admin price change reaches new requests only; admin sets each place
 *      North, South or none;
 *   3b. nobody pays more than they were shown: an app that sends no price
 *      (older builds, which show GH₵7) pays at most GH₵7 for Shared; a stale
 *      shown price is refused (FARE_CHANGED) and books nothing;
 *   4. a refused booking leaves an anonymous record (no rider, no pin) —
 *      at POST /rides, and at the quote while booking is blocked (once per
 *      rider and trip) — and admin counts them per day and reason.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { FarEnd, Place } from "@prisma/client";
import { splitFare, type FareQuote } from "@rida/shared";
import { prisma } from "../db/prisma";
import { registerRideRoutes } from "./rides";
import { registerDriverRoutes } from "./driver";
import { registerAdminDispatchRoutes } from "./adminDispatch";
import { signAccessToken } from "../services/auth/tokens";
import { createTestDriver, createTestUser, getTestZones } from "../services/ride/testFixtures";
import { clearFarePricingCache } from "../services/ride/farePricing";
import { resetRefusedBookingsForTests } from "../services/ride/refusedBookings";
import { clearServiceHoursCache, setServiceHoursGateForTests } from "../services/service/serviceHours";
import { clearAdminCache } from "../services/admin/cache";

let app: FastifyInstance;
const userIds: string[] = [];
const placeIds: string[] = [];
let north: Place; // Bani Hostel (north end)
let northToo: Place; // Pentagon Block A (north end)
let south: Place; // Jean Nelson Aka Hall (south end)
let southToo: Place; // Elizabeth Sey Pharmacy (south end, beside Sey Hall)
let campus: Place; // Balme Library (main campus)
let campusToo: Place; // Akuafo Hall (main campus)

beforeAll(async () => {
  app = Fastify();
  registerRideRoutes(app, prisma);
  registerDriverRoutes(app, prisma);
  registerAdminDispatchRoutes(app, prisma);
  await app.ready();
  const { pickup } = await getTestZones();
  const place = async (name: string, latitude: number, longitude: number, farEnd: FarEnd | null) => {
    const p = await prisma.place.create({ data: { name: `Far test ${name}`, latitude, longitude, zoneId: pickup.id, farEnd } });
    placeIds.push(p.id);
    return p;
  };
  north = await place("Bani Hostel", 5.663256, -0.179997, "NORTH");
  northToo = await place("Pentagon Block A", 5.657652, -0.182018, "NORTH");
  south = await place("Jean Nelson Aka Hall", 5.63534, -0.188475, "SOUTH");
  southToo = await place("Elizabeth Sey Pharmacy", 5.635414, -0.187468, "SOUTH");
  campus = await place("Balme Library", 5.652012, -0.187048, null);
  campusToo = await place("Akuafo Hall", 5.649357, -0.186087, null);
});

beforeEach(async () => {
  await prisma.farePricingSetting.deleteMany({});
  await prisma.refusedBooking.deleteMany({});
  clearFarePricingCache();
  clearAdminCache();
  resetRefusedBookingsForTests();
});

afterEach(async () => {
  const ids = userIds.splice(0);
  await prisma.ride.deleteMany({ where: { OR: [{ riderId: { in: ids } }, { driverId: { in: ids } }] } });
  await prisma.driver.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  setServiceHoursGateForTests(false);
  await prisma.serviceHoursSetting.deleteMany({});
  clearServiceHoursCache();
});

afterAll(async () => {
  await prisma.farePricingSetting.deleteMany({});
  await prisma.refusedBooking.deleteMany({});
  await prisma.place.deleteMany({ where: { id: { in: placeIds } } });
  await app.close();
});

async function person(role: "RIDER" | "ADMIN" = "RIDER") {
  const created = await createTestUser("RIDER");
  const user = role === "ADMIN" ? await prisma.user.update({ where: { id: created.id }, data: { role } }) : created;
  userIds.push(user.id);
  return { user, headers: { authorization: `Bearer ${signAccessToken({ userId: user.id, role })}` } };
}

const at = (p: Place) => ({ placeId: p.id });

async function quote(rider: { headers: Record<string, string> }, pickup: object, dropoff: object): Promise<FareQuote> {
  const res = await app.inject({ method: "POST", url: "/rides/quote", headers: rider.headers, payload: { pickup, dropoff } });
  expect(res.statusCode).toBe(200);
  return res.json() as FareQuote;
}

/** Books as a current app does: sending the price Choose a ride showed (the quote), unless `shown` says otherwise. */
async function book(
  rider: { headers: Record<string, string> },
  type: "SHARED" | "LONE",
  pickup: object,
  dropoff: object,
  shown: number | "quote" | "none" = "quote",
) {
  const shownFarePesewas = shown === "quote" ? (await quote(rider, pickup, dropoff)).fares[type] : shown === "none" ? undefined : shown;
  const res = await app.inject({ method: "POST", url: "/rides", headers: rider.headers, payload: { type, pickup, dropoff, shownFarePesewas } });
  expect(res.statusCode).toBe(201);
  const id = (res.json() as { ride: { id: string } }).ride.id;
  return prisma.ride.findUniqueOrThrow({ where: { id }, include: { passengers: true } });
}

const FAR = { fares: { SHARED: 900, LONE: 1500 }, farTrip: true };
const NORMAL = { fares: { SHARED: 700, LONE: 1500 }, farTrip: false };

describe("far-trip price rules (two far ends)", () => {
  it("North ↔ South is GH₵9, both directions", async () => {
    const rider = await person();
    expect(await quote(rider, at(north), at(south))).toEqual(FAR);
    expect(await quote(rider, at(south), at(north))).toEqual(FAR);
    expect(await quote(rider, at(northToo), at(southToo))).toEqual(FAR);
  });

  it("main campus ↔ North is GH₵7, both directions", async () => {
    const rider = await person();
    expect(await quote(rider, at(campus), at(north))).toEqual(NORMAL);
    expect(await quote(rider, at(northToo), at(campus))).toEqual(NORMAL);
  });

  it("main campus ↔ South is GH₵7, both directions", async () => {
    const rider = await person();
    expect(await quote(rider, at(campus), at(south))).toEqual(NORMAL);
    expect(await quote(rider, at(southToo), at(campusToo))).toEqual(NORMAL);
  });

  it("inside North, inside South, and main campus ↔ main campus are GH₵7", async () => {
    const rider = await person();
    expect(await quote(rider, at(north), at(northToo))).toEqual(NORMAL);
    expect(await quote(rider, at(south), at(southToo))).toEqual(NORMAL);
    expect(await quote(rider, at(campus), at(campusToo))).toEqual(NORMAL);
  });

  it("Ride alone is GH₵15 everywhere", async () => {
    const rider = await person();
    for (const [a, b] of [[north, south], [south, north], [campus, north], [south, campus], [north, northToo], [campus, campusToo]] as const) {
      expect((await quote(rider, at(a), at(b))).fares.LONE).toBe(1500);
    }
  });

  it("a pin with no place chosen counts by the place it's near (≤ 250 m), not beyond", async () => {
    const rider = await person();
    const nearBani = { latitude: north.latitude + 0.001, longitude: north.longitude }; // ~110 m north
    expect((await quote(rider, nearBani, at(south))).fares.SHARED).toBe(900);
    const offCluster = { latitude: 5.6610, longitude: -0.1855 }; // > 250 m from every test place
    expect((await quote(rider, offCluster, at(south))).fares.SHARED).toBe(700);
  });
});

describe("the price is set when the request is made", () => {
  it("the seat is locked at the quoted price; Ride alone at GH₵15", async () => {
    const rider = await person();
    const shared = await book(rider, "SHARED", at(north), at(south));
    expect(shared.passengers[0]!.lockedFare).toBe(900);
    await prisma.ride.update({ where: { id: shared.id }, data: { status: "CANCELLED" } });
    const lone = await book(rider, "LONE", at(north), at(south));
    expect(lone.passengers[0]!.lockedFare).toBe(1500);
  });

  it("switching Ride alone → Shared takes the far price for that trip", async () => {
    const rider = await person();
    const ride = await book(rider, "LONE", at(south), at(north));
    const res = await app.inject({ method: "POST", url: `/rides/${ride.id}/switch`, headers: rider.headers, payload: { type: "SHARED", shownFarePesewas: 900 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().farePesewas).toBe(900);
    expect((await prisma.ridePassenger.findFirstOrThrow({ where: { rideId: ride.id } })).lockedFare).toBe(900);
  });

  it("an older app that shows no quote (it shows GH₵7) is never charged more: Shared ≤ GH₵7, Ride alone GH₵15", async () => {
    const rider = await person();
    const shared = await book(rider, "SHARED", at(north), at(south), "none");
    expect(shared.passengers[0]!.lockedFare).toBe(700);
    await prisma.ride.update({ where: { id: shared.id }, data: { status: "CANCELLED" } });
    const lone = await book(rider, "LONE", at(north), at(south), "none");
    expect(lone.passengers[0]!.lockedFare).toBe(1500);
    // Switching from an older app: the same rule.
    const res = await app.inject({ method: "POST", url: `/rides/${lone.id}/switch`, headers: rider.headers, payload: { type: "SHARED" } });
    expect(res.json().farePesewas).toBe(700);
  });

  it("a stale shown price is refused with the new one, and nothing is booked", async () => {
    const rider = await person();
    const res = await app.inject({
      method: "POST",
      url: "/rides",
      headers: rider.headers,
      payload: { type: "SHARED", pickup: at(north), dropoff: at(south), shownFarePesewas: 700 },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: "FARE_CHANGED", farePesewas: 900, error: "The price for this trip has just changed to GH₵9. Check it and request again." });
    expect(await prisma.ride.count({ where: { riderId: rider.user.id } })).toBe(0);
  });

  it("the driver's offer shows the locked fare and their 85% of it", async () => {
    const rider = await person();
    const ride = await book(rider, "SHARED", at(north), at(south));
    const { user } = await createTestDriver({ isOnline: true, currentZoneId: ride.pickupZoneId });
    userIds.push(user.id);
    const res = await app.inject({
      method: "GET",
      url: "/driver/rides/eligible",
      headers: { authorization: `Bearer ${signAccessToken({ userId: user.id, role: "DRIVER" })}` },
    });
    const offer = (res.json() as { rides: Array<{ rideId: string; farePesewas: number; driverSharePesewas: number }> }).rides.find((r) => r.rideId === ride.id);
    expect(offer).toMatchObject({ farePesewas: 900, driverSharePesewas: 765 });
    expect(splitFare(900)).toEqual({ commission: 135, driverShare: 765 });
  });

  it("an admin price change reaches new requests only; a ride already requested keeps its price", async () => {
    const admin = await person("ADMIN");
    const rider = await person();
    const before = await book(rider, "SHARED", at(north), at(south));
    const ends = [north, northToo].map((p) => ({ id: p.id, end: "NORTH" })).concat([south, southToo].map((p) => ({ id: p.id, end: "SOUTH" })));

    const save = await app.inject({
      method: "PUT",
      url: "/admin/far-pricing",
      headers: admin.headers,
      payload: { sharedPesewas: 800, sharedFarPesewas: 1000, farPlaces: ends },
    });
    expect(save.statusCode).toBe(200);
    expect(save.json().settings).toMatchObject({ sharedPesewas: 800, sharedFarPesewas: 1000, loneFarePesewas: 1500 });

    expect((await prisma.ridePassenger.findFirstOrThrow({ where: { rideId: before.id } })).lockedFare).toBe(900);
    const other = await person();
    expect((await quote(other, at(north), at(south))).fares).toEqual({ SHARED: 1000, LONE: 1500 });
    expect((await quote(other, at(campus), at(north))).fares.SHARED).toBe(800);
    const log = await prisma.adminAuditLog.findFirst({ where: { action: "fares.update", actor: admin.user.id } });
    expect(log?.reason).toContain("far Shared 900 → 1000");
    await prisma.adminAuditLog.deleteMany({ where: { actor: admin.user.id } });
  });

  it("admin sets each place North, South or none; bad input is refused", async () => {
    const admin = await person("ADMIN");
    const put = (payload: object) => app.inject({ method: "PUT", url: "/admin/far-pricing", headers: admin.headers, payload });
    expect((await put({ sharedPesewas: 700, sharedFarPesewas: 1600, farPlaces: [] })).statusCode).toBe(400);
    expect((await put({ sharedPesewas: 700, sharedFarPesewas: 900, farPlaces: [{ id: "nope", end: "NORTH" }] })).statusCode).toBe(400);
    expect((await put({ sharedPesewas: 700, sharedFarPesewas: 900, farPlaces: [{ id: north.id, end: "EAST" }] })).statusCode).toBe(400);
    expect(
      (await put({ sharedPesewas: 700, sharedFarPesewas: 900, farPlaces: [{ id: north.id, end: "NORTH" }, { id: north.id, end: "SOUTH" }] })).statusCode,
    ).toBe(400);

    // Bani moved to the south end, Jean Nelson Aka to none: Bani → Pharmacy is now inside one end.
    const res = await put({ sharedPesewas: 700, sharedFarPesewas: 900, farPlaces: [{ id: north.id, end: "SOUTH" }, { id: southToo.id, end: "SOUTH" }, { id: northToo.id, end: "NORTH" }] });
    expect(res.statusCode).toBe(200);
    expect(res.json().farPlaces.map((p: { id: string; end: string }) => [p.id, p.end]).sort()).toEqual(
      [[north.id, "SOUTH"], [southToo.id, "SOUTH"], [northToo.id, "NORTH"]].sort(),
    );
    const rider = await person();
    expect((await quote(rider, at(north), at(southToo))).fares.SHARED).toBe(700);
    expect((await quote(rider, at(north), at(northToo))).fares.SHARED).toBe(900);
    expect((await quote(rider, at(south), at(northToo))).fares.SHARED).toBe(700);
    await prisma.place.update({ where: { id: north.id }, data: { farEnd: "NORTH" } });
    await prisma.place.update({ where: { id: south.id }, data: { farEnd: "SOUTH" } });
    await prisma.adminAuditLog.deleteMany({ where: { actor: admin.user.id } });
  });
});

describe("refused bookings", () => {
  async function closeService() {
    setServiceHoursGateForTests(true);
    await prisma.serviceHoursSetting.create({
      data: { id: "service", weekly: Array.from({ length: 7 }, () => null), blockWhenNoDrivers: false },
    });
    clearServiceHoursCache();
  }

  it("a refused POST /rides leaves an anonymous record: reason, places and zones, no rider or pin", async () => {
    await closeService();
    const rider = await person();
    const res = await app.inject({ method: "POST", url: "/rides", headers: rider.headers, payload: { type: "SHARED", pickup: at(north), dropoff: at(campus) } });
    expect(res.statusCode).toBe(422);
    const rows = await prisma.refusedBooking.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      reason: "SERVICE_CLOSED",
      stage: "REQUEST",
      rideType: "SHARED",
      pickupLabel: north.name,
      dropoffLabel: campus.name,
    });
    expect(rows[0]!.pickupZoneId).not.toBeNull();
    // Nothing that says who, nor the exact spot.
    expect(Object.keys(rows[0]!).sort()).toEqual(
      ["createdAt", "dropoffLabel", "dropoffZoneId", "id", "pickupLabel", "pickupZoneId", "reason", "rideType", "stage"].sort(),
    );
    expect(JSON.stringify(rows[0])).not.toContain(rider.user.id);
  });

  it("outside the service area is recorded with no zone for that end", async () => {
    const rider = await person();
    const res = await app.inject({
      method: "POST",
      url: "/rides",
      headers: rider.headers,
      payload: { type: "LONE", pickup: { latitude: 5.6, longitude: -0.25 }, dropoff: at(campus) },
    });
    expect(res.statusCode).toBe(422);
    const [row] = await prisma.refusedBooking.findMany();
    expect(row).toMatchObject({ reason: "OUTSIDE_SERVICE_AREA", stage: "REQUEST", pickupZoneId: null, pickupLabel: null, dropoffLabel: campus.name });
  });

  it("a quote while booking is blocked is still answered, and recorded once per rider and trip", async () => {
    await closeService();
    const rider = await person();
    expect((await quote(rider, at(north), at(south))).fares.SHARED).toBe(900);
    await quote(rider, at(north), at(south));
    await quote(rider, at(north), at(south));
    const other = await person();
    await quote(other, at(north), at(south));
    const rows = await prisma.refusedBooking.findMany();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.stage === "QUOTE" && r.reason === "SERVICE_CLOSED")).toBe(true);
  });

  it("an open service records nothing", async () => {
    const rider = await person();
    await quote(rider, at(north), at(campus));
    await book(rider, "SHARED", at(north), at(campus));
    expect(await prisma.refusedBooking.count()).toBe(0);
  });

  it("admin sees a count per day and per reason", async () => {
    const admin = await person("ADMIN");
    const now = new Date();
    const zone = (await getTestZones()).pickup;
    await prisma.refusedBooking.createMany({
      data: [
        { reason: "SERVICE_CLOSED", stage: "REQUEST", createdAt: now, pickupZoneId: zone.id },
        { reason: "SERVICE_CLOSED", stage: "QUOTE", createdAt: now, pickupZoneId: zone.id },
        { reason: "NO_DRIVERS_ONLINE", stage: "QUOTE", createdAt: now },
      ],
    });
    const from = new Date(now.getTime() - 86_400_000).toISOString();
    const to = new Date(now.getTime() + 60_000).toISOString();
    const res = await app.inject({ method: "GET", url: `/admin/refused-bookings?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, headers: admin.headers });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(3);
    expect(body.byReason).toEqual([
      { reason: "SERVICE_CLOSED", total: 2, requests: 1, quotes: 1 },
      { reason: "NO_DRIVERS_ONLINE", total: 1, requests: 0, quotes: 1 },
    ]);
    const today = body.days.find((d: { total: number }) => d.total > 0);
    expect(today).toMatchObject({ total: 3, byReason: { SERVICE_CLOSED: 2, NO_DRIVERS_ONLINE: 1 }, requests: 1, quotes: 2 });
    expect(body.topPickupZones[0]).toMatchObject({ zoneId: zone.id, name: zone.name, total: 2 });
    expect(body.labels.SERVICE_CLOSED).toBe("Outside service hours");
  });
});

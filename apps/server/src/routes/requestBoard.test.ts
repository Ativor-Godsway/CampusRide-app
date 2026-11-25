/**
 * The request board and the 7-minute search window (2026-11-25). Pins:
 *   1. the board lists every open request on campus (any zone) and nothing
 *      else: not expired, taken, cancelled or declined by this driver; an
 *      offline driver gets nothing;
 *   2. several taken at once: claim one, add the rest, up to 4 riders — a
 *      full car refuses (CAR_FULL); one another driver took answers "taken"
 *      and the rest still go in;
 *   3. during a trip it says which requests fit the car, and why not;
 *   4. requests search for 7 minutes (admin setting), then expire;
 *   5. how each request was taken is saved: POPUP, LIST, BOARD (none: null).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { Zone } from "@prisma/client";
import { prisma } from "../db/prisma";
import { registerDriverRoutes } from "./driver";
import { registerAdminDispatchRoutes } from "./adminDispatch";
import { signAccessToken } from "../services/auth/tokens";
import { createRide } from "../services/ride/createRide";
import { createTestDriver, createTestUser, getThreeTestZones } from "../services/ride/testFixtures";
import { readSearchWindow, searchWindowMs, setSearchWindowForTests } from "../services/ride/searchWindow";
import { shouldTimeout } from "../services/ride/timeouts";

// The board reads the database itself: the fire-and-forget broadcast that
// createRide starts isn't needed, and would still be logging as the file ends.
vi.mock("../services/ride/dispatch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/ride/dispatch")>()),
  broadcastRide: vi.fn(async () => []),
}));

let app: FastifyInstance;
let zones: { pickup: Zone; adjacent: Zone; distant: Zone };
const userIds: string[] = [];

beforeAll(async () => {
  app = Fastify();
  registerDriverRoutes(app, prisma);
  registerAdminDispatchRoutes(app, prisma);
  await app.ready();
  zones = await getThreeTestZones();
});

beforeEach(() => setSearchWindowForTests());

afterEach(async () => {
  const ids = userIds.splice(0);
  await prisma.ride.deleteMany({ where: { OR: [{ riderId: { in: ids } }, { driverId: { in: ids } }] } });
  await prisma.driver.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.dispatchSetting.deleteMany({});
  setSearchWindowForTests();
});

afterAll(async () => {
  await app.close();
});

const MIN = 60_000;

async function driver(opts: { isOnline?: boolean } = {}) {
  const { user } = await createTestDriver({ isOnline: opts.isOnline ?? true, currentZoneId: zones.pickup.id });
  userIds.push(user.id);
  return { id: user.id, headers: { authorization: `Bearer ${signAccessToken({ userId: user.id, role: "DRIVER" })}` } };
}

/** An open request from a new rider, picked up in `zone`, searching for `agoMs`. */
async function request(type: "SHARED" | "LONE" = "SHARED", zone: Zone = zones.pickup, agoMs = 0) {
  const rider = await createTestUser("RIDER");
  userIds.push(rider.id);
  const dropoff = zone.id === zones.distant.id ? zones.pickup : zones.distant;
  const ride = await createRide(prisma, { riderId: rider.id, type, pickupZoneId: zone.id, dropoffZoneId: dropoff.id });
  if (agoMs) await prisma.ride.update({ where: { id: ride.id }, data: { broadcastStartedAt: new Date(Date.now() - agoMs) } });
  return ride.id;
}

type BoardBody = {
  open: boolean;
  online: boolean;
  car: { rideId: string; type: string; freeSeats: number } | null;
  rides: Array<{ rideId: string; farePesewas: number; seats: number; boardCanTake: boolean; boardNote: string | null; searchingSince: string; pickupZoneName: string }>;
};

async function board(d: { headers: Record<string, string> }): Promise<BoardBody> {
  const res = await app.inject({ method: "GET", url: "/driver/requests/board", headers: d.headers });
  expect(res.statusCode).toBe(200);
  return res.json() as BoardBody;
}
const ids = (b: BoardBody) => b.rides.map((r) => r.rideId);

const claim = (d: { headers: Record<string, string> }, rideId: string, source?: string) =>
  app.inject({ method: "POST", url: `/rides/${rideId}/claim`, headers: d.headers, payload: source ? { source } : {} });
const add = (d: { headers: Record<string, string> }, carId: string, requestRideId: string, source?: string) =>
  app.inject({ method: "POST", url: `/rides/${carId}/add-passenger`, headers: d.headers, payload: { requestRideId, ...(source ? { source } : {}) } });

describe("the board lists open requests only", () => {
  it("every open request on campus, in any zone — not expired, taken, cancelled or declined", async () => {
    const me = await driver();
    const other = await driver();
    const here = await request();
    const far = await request("LONE", zones.distant);
    const expired = await request("SHARED", zones.pickup, 8 * MIN);
    const taken = await request();
    expect((await claim(other, taken)).statusCode).toBe(200);
    const cancelled = await request();
    await prisma.ride.update({ where: { id: cancelled }, data: { status: "CANCELLED", cancelReason: "RIDER_CANCELLED" } });
    const declined = await request();
    await prisma.rideRejection.create({ data: { rideId: declined, driverUserId: me.id, reason: "DECLINED" } });

    const b = await board(me);
    expect(b).toMatchObject({ open: true, online: true, car: null });
    expect(ids(b)).toEqual(expect.arrayContaining([here, far]));
    for (const gone of [expired, taken, cancelled, declined]) expect(ids(b)).not.toContain(gone);
    const card = b.rides.find((r) => r.rideId === here)!;
    expect(card).toMatchObject({ farePesewas: 700, seats: 1, boardCanTake: true, boardNote: null, pickupZoneName: zones.pickup.name });
    expect(Date.parse(card.searchingSince)).toBeGreaterThan(Date.now() - MIN);
    expect(b.rides.find((r) => r.rideId === far)).toMatchObject({ farePesewas: 1500, boardCanTake: true });
  });

  it("an offline driver sees nothing", async () => {
    const off = await driver({ isOnline: false });
    await request();
    expect(await board(off)).toMatchObject({ online: false, rides: [] });
  });
});

describe("taking several at once", () => {
  it("claim one, add the rest up to 4 riders; then the car is full", async () => {
    const me = await driver();
    const r = [await request(), await request(), await request(), await request(), await request()];
    expect((await claim(me, r[0]!, "BOARD")).statusCode).toBe(200);
    for (const id of r.slice(1, 4)) expect((await add(me, r[0]!, id, "BOARD")).statusCode).toBe(200);
    const full = await add(me, r[0]!, r[4]!, "BOARD");
    expect(full.statusCode).toBe(409);
    expect(full.json().code).toBe("CAR_FULL");
    expect(await prisma.ridePassenger.count({ where: { rideId: r[0]!, status: { not: "CANCELLED" } } })).toBe(4);
  });

  it("one another driver took answers 'already taken'; the rest still go in", async () => {
    const me = await driver();
    const rival = await driver();
    const [first, stolen, last] = [await request(), await request(), await request()];
    expect((await claim(me, first!, "BOARD")).statusCode).toBe(200);
    expect((await claim(rival, stolen!)).statusCode).toBe(200);
    const res = await add(me, first!, stolen!, "BOARD");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "REQUEST_UNAVAILABLE", reason: "TAKEN" });
    expect((await add(me, first!, last!, "BOARD")).statusCode).toBe(200);
  });
});

describe("the board during a trip", () => {
  it("says what fits the car and why the rest don't; full car: nothing fits", async () => {
    const me = await driver();
    const car = await request();
    expect((await claim(me, car, "BOARD")).statusCode).toBe(200);
    const fits = await request("SHARED", zones.adjacent);
    const lone = await request("LONE");

    let b = await board(me);
    expect(b.car).toMatchObject({ rideId: car, type: "SHARED", freeSeats: 3 });
    expect(ids(b)).not.toContain(car);
    expect(b.rides.find((r) => r.rideId === fits)).toMatchObject({ boardCanTake: true });
    expect(b.rides.find((r) => r.rideId === lone)).toMatchObject({ boardCanTake: false, boardNote: "Ride alone: needs an empty car" });

    for (let i = 0; i < 3; i++) expect((await add(me, car, await request(), "BOARD")).statusCode).toBe(200);
    b = await board(me);
    expect(b.car?.freeSeats).toBe(0);
    expect(b.rides.find((r) => r.rideId === fits)).toMatchObject({ boardCanTake: false, boardNote: "Your car is full" });
  });

  it("a Ride alone trip takes nobody", async () => {
    const me = await driver();
    const car = await request("LONE");
    expect((await claim(me, car)).statusCode).toBe(200);
    const shared = await request();
    expect((await board(me)).rides.find((r) => r.rideId === shared)).toMatchObject({ boardCanTake: false, boardNote: "Your trip is Ride alone" });
  });
});

describe("requests search for 7 minutes", () => {
  it("is 7 minutes by default: still on the board at 6:50, gone at 7:10", async () => {
    expect(searchWindowMs()).toBe(7 * MIN);
    const me = await driver();
    const young = await request("SHARED", zones.pickup, 6 * MIN + 50_000);
    const old = await request("SHARED", zones.pickup, 7 * MIN + 10_000);
    const b = await board(me);
    expect(ids(b)).toContain(young);
    expect(ids(b)).not.toContain(old);
  });

  it("expires at 7 minutes, not 2", () => {
    const start = new Date("2026-11-25T08:00:00Z");
    const ride = { status: "REQUESTED", createdAt: start, broadcastStartedAt: start, decisionStartedAt: null };
    expect(shouldTimeout(ride, new Date(start.getTime() + 2 * MIN))).toBe(false);
    expect(shouldTimeout(ride, new Date(start.getTime() + 7 * MIN - 1000))).toBe(false);
    expect(shouldTimeout(ride, new Date(start.getTime() + 7 * MIN))).toBe(true);
  });

  it("is an admin setting (1–30 minutes), audit-logged, used at once", async () => {
    const created = await createTestUser("RIDER");
    userIds.push(created.id);
    await prisma.user.update({ where: { id: created.id }, data: { role: "ADMIN" } });
    const headers = { authorization: `Bearer ${signAccessToken({ userId: created.id, role: "ADMIN" })}` };
    const put = (searchWindowSeconds: number) => app.inject({ method: "PUT", url: "/admin/dispatch-settings", headers, payload: { searchWindowSeconds } });
    expect((await put(30)).statusCode).toBe(400);
    const res = await put(300);
    expect(res.statusCode).toBe(200);
    expect(res.json().settings.searchWindowSeconds).toBe(300);
    expect(searchWindowMs()).toBe(5 * MIN);
    const start = new Date();
    expect(shouldTimeout({ status: "REQUESTED", createdAt: start, broadcastStartedAt: start, decisionStartedAt: null }, new Date(start.getTime() + 5 * MIN))).toBe(true);
    expect((await readSearchWindow(prisma)).searchWindowSeconds).toBe(300);
    expect(await prisma.adminAuditLog.count({ where: { action: "dispatch.search_window", actor: created.id } })).toBe(1);
    await prisma.adminAuditLog.deleteMany({ where: { actor: created.id } });
  });
});

describe("how each request was taken is saved", () => {
  it("POPUP, LIST, BOARD on the request; an app that says nothing: null", async () => {
    const me = await driver();
    const popup = await request();
    expect((await claim(me, popup, "POPUP")).statusCode).toBe(200);
    const listed = await request();
    expect((await add(me, popup, listed, "LIST")).statusCode).toBe(200);
    const boarded = await request();
    expect((await add(me, popup, boarded, "BOARD")).statusCode).toBe(200);
    const via = async (id: string) => (await prisma.ride.findUniqueOrThrow({ where: { id } })).acceptedVia;
    expect(await via(popup)).toBe("POPUP");
    expect(await via(listed)).toBe("LIST");
    expect(await via(boarded)).toBe("BOARD");

    const other = await driver();
    const silent = await request();
    expect((await claim(other, silent)).statusCode).toBe(200);
    expect(await via(silent)).toBeNull();
    expect((await claim(other, await request(), "SOMEWHERE")).statusCode).toBe(400);
  });
});

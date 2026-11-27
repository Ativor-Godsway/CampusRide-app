/**
 * Fill moving cars first + auto-add (services/ride/movingFirst.ts): a new
 * live Shared request goes first to the best compatible car already on a
 * trip — added at once (auto-add, with Undo) or offered to that driver only
 * for 20 s — and only then to everyone else.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { Zone } from "@prisma/client";

const push = vi.hoisted(() => ({ sent: [] as Array<{ kind: string; userIds: readonly string[]; body?: string }> }));
vi.mock("../push/pushService", async (original) => ({
  ...(await original<typeof import("../push/pushService")>()),
  isPushEnabled: () => true,
  sendPush: vi.fn(async (_p: unknown, input: { kind: string; userIds: readonly string[]; text?: { schedule?: { body: string } } }) => {
    push.sent.push({ kind: input.kind, userIds: input.userIds, body: input.text?.schedule?.body });
    return 1;
  }),
}));

import { prisma } from "../../db/prisma";
import { signAccessToken } from "../auth/tokens";
import { createTestDriver, createTestUser, getThreeTestZones } from "./testFixtures";
import { broadcastRide, claimIfOpen } from "./dispatch";
import { expireHold, releaseHold, undoAutoAdd, UndoAddError } from "./movingFirst";
import { requestsForDriver } from "./requestFit";
import { seatCancelledBy } from "./cancels";
import { setMovingFirstForTests } from "./searchWindow";
import { setScheduleSettingsForTests } from "../scheduled/settings";
import { registerDriverRoutes } from "../../routes/driver";
import { registerAdminDispatchRoutes } from "../../routes/adminDispatch";

let zones: { pickup: Zone; adjacent: Zone; distant: Zone };
const users: string[] = [];
let app: FastifyInstance;

/** North-bound along campus; SOUTH is the other way. */
const NORTH = { latitude: 5.664, longitude: -0.183 };
const NEAR_NORTH = { latitude: 5.6632, longitude: -0.1834 };
const SOUTH = { latitude: 5.643, longitude: -0.19 };

async function rider() {
  const u = await createTestUser("RIDER");
  users.push(u.id);
  return u;
}

async function driver(opts: { autoAdd?: boolean | null; app?: boolean; at?: Zone } = {}) {
  const at = opts.at ?? zones.pickup;
  const { user } = await createTestDriver({ isOnline: true, isApproved: true, currentZoneId: at.id });
  await prisma.driver.update({
    where: { userId: user.id },
    data: { lastLat: at.latitude, lastLng: at.longitude, autoAddRiders: opts.autoAdd ?? null, autoAddAppAt: opts.app === false ? null : new Date() },
  });
  users.push(user.id);
  return user;
}

/** A Shared car on its way: one booking from the pickup zone towards `to`. */
async function movingCar(driverId: string, opts: { seats?: number; to?: { latitude: number; longitude: number }; type?: "SHARED" | "LONE"; booking?: "LIVE" | "SCHEDULED" } = {}) {
  const r = await rider();
  const to = opts.to ?? NORTH;
  return prisma.ride.create({
    data: {
      riderId: r.id,
      driverId,
      type: opts.type ?? "SHARED",
      status: "MATCHED",
      matchedAt: new Date(),
      booking: opts.booking ?? "LIVE",
      pickupZoneId: zones.pickup.id,
      dropoffZoneId: zones.adjacent.id,
      occupancy: opts.seats ?? 1,
      pickupLat: zones.pickup.latitude,
      pickupLng: zones.pickup.longitude,
      dropoffLat: to.latitude,
      dropoffLng: to.longitude,
      passengers: {
        create: {
          riderId: r.id,
          pickupZoneId: zones.pickup.id,
          dropoffZoneId: zones.adjacent.id,
          status: "WAITING",
          lockedFare: 700,
          seats: opts.seats ?? 1,
          pickupLat: zones.pickup.latitude,
          pickupLng: zones.pickup.longitude,
          dropoffLat: to.latitude,
          dropoffLng: to.longitude,
        },
      },
    },
  });
}

/** A new live request (not yet broadcast). */
async function request(opts: { to?: { latitude: number; longitude: number }; seats?: number; type?: "SHARED" | "LONE" } = {}) {
  const r = await rider();
  const to = opts.to ?? NEAR_NORTH;
  return prisma.ride.create({
    data: {
      riderId: r.id,
      type: opts.type ?? "SHARED",
      status: "REQUESTED",
      broadcastStartedAt: new Date(),
      pickupZoneId: zones.pickup.id,
      dropoffZoneId: zones.adjacent.id,
      occupancy: opts.seats ?? 1,
      pickupLat: zones.pickup.latitude + 0.0003,
      pickupLng: zones.pickup.longitude,
      dropoffLat: to.latitude,
      dropoffLng: to.longitude,
      passengers: {
        create: {
          riderId: r.id,
          pickupZoneId: zones.pickup.id,
          dropoffZoneId: zones.adjacent.id,
          status: "WAITING",
          lockedFare: 700 * (opts.seats ?? 1),
          seats: opts.seats ?? 1,
          pickupLat: zones.pickup.latitude + 0.0003,
          pickupLng: zones.pickup.longitude,
          dropoffLat: to.latitude,
          dropoffLng: to.longitude,
        },
      },
    },
  });
}

const reload = (id: string) => prisma.ride.findUniqueOrThrow({ where: { id }, include: { passengers: true } });

beforeAll(async () => {
  zones = await getThreeTestZones();
  app = Fastify();
  registerDriverRoutes(app, prisma);
  registerAdminDispatchRoutes(app, prisma);
  await app.ready();
});

beforeEach(async () => {
  setMovingFirstForTests({ movingFirstEnabled: true, autoAddDefault: true });
  setScheduleSettingsForTests();
  push.sent = [];
  await prisma.driver.updateMany({ where: { userId: { in: users } }, data: { isOnline: false } });
});

afterAll(async () => {
  setMovingFirstForTests({ movingFirstEnabled: false });
  await prisma.ride.deleteMany({ where: { OR: [{ riderId: { in: users } }, { driverId: { in: users } }] } });
  await prisma.dispatchSetting.deleteMany({});
  await prisma.adminAuditLog.deleteMany({ where: { actor: { in: users } } });
  await prisma.driver.deleteMany({ where: { userId: { in: users } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await app.close();
});

describe("auto-add on (the default)", () => {
  it("joins the moving car at once, with an Undo window, the rider's 'joined' push and the driver's 'Rider added' push", async () => {
    const d = await driver();
    const car = await movingCar(d.id);
    const req = await request();
    await broadcastRide(prisma, req.id);

    const after = await reload(req.id);
    expect(after).toMatchObject({ status: "CANCELLED", cancelReason: "MERGED_INTO_ANOTHER_RIDE", mergedIntoRideId: car.id, movingStep: "AUTO_ADDED", acceptedVia: "AUTO" });
    expect(after.movingDetourMeters).not.toBeNull();
    const seat = (await reload(car.id)).passengers.find((p) => p.riderId === req.riderId)!;
    expect(seat.status).toBe("WAITING");
    expect(seat.autoAddUndoUntil!.getTime()).toBeGreaterThan(Date.now());
    expect(seat.movingJoinEtaMin).toBeGreaterThanOrEqual(1);
    await vi.waitFor(() => expect(push.sent.map((p) => p.kind)).toEqual(expect.arrayContaining(["RIDER_ADDED", "JOINED_CAR"])));
    expect(push.sent.find((p) => p.kind === "RIDER_ADDED")!.userIds).toEqual([d.id]);
    expect(push.sent.find((p) => p.kind === "RIDER_ADDED")!.body).toMatch(/· \+GH₵7 · \+\d+ min$/);
    expect(push.sent.find((p) => p.kind === "JOINED_CAR")!.body).toMatch(/^Already on the way\. Pickup in about \d+ min\.$/);
  });

  it("Undo (within 15 s): the seat comes off without penalty and the request is searching again, never offered to that driver", async () => {
    const d = await driver();
    const car = await movingCar(d.id);
    const req = await request();
    await broadcastRide(prisma, req.id);
    const seat = (await reload(car.id)).passengers.find((p) => p.riderId === req.riderId)!;

    await undoAutoAdd(prisma, d.id, car.id, seat.id);
    const reopened = await reload(req.id);
    expect(reopened).toMatchObject({ status: "REQUESTED", mergedIntoRideId: null, cancelReason: null, movingStep: "UNDONE", movingHoldUntil: null });
    expect((await prisma.ridePassenger.findUniqueOrThrow({ where: { id: seat.id } })).status).toBe("CANCELLED");
    expect(await seatCancelledBy(prisma, car.id, seat.id)).toEqual({ seatCancelledBy: "driver", rebookedRideId: req.id, undone: true });
    expect(await prisma.rideRejection.count({ where: { rideId: req.id, driverUserId: d.id } })).toBe(1);
    expect(await prisma.driverCancellation.count({ where: { driverUserId: d.id } })).toBe(0);
    // A second undo, or one after the window: too late.
    await expect(undoAutoAdd(prisma, d.id, car.id, seat.id)).rejects.toBeInstanceOf(UndoAddError);
  });

  it("Undo after 15 s is refused", async () => {
    const d = await driver();
    const car = await movingCar(d.id);
    const req = await request();
    await broadcastRide(prisma, req.id);
    const seat = (await reload(car.id)).passengers.find((p) => p.riderId === req.riderId)!;
    await expect(undoAutoAdd(prisma, d.id, car.id, seat.id, new Date(Date.now() + 16_000))).rejects.toMatchObject({ code: "TOO_LATE" });
  });

  it("a driver app that can't show it (no feature): an exclusive offer instead", async () => {
    const d = await driver({ app: false });
    await movingCar(d.id);
    const req = await request();
    await broadcastRide(prisma, req.id);
    expect(await reload(req.id)).toMatchObject({ status: "REQUESTED", movingStep: "OFFERED", movingHoldDriverId: d.id });
  });
});

describe("auto-add off: an exclusive 20 s offer", () => {
  it("idle drivers don't see it or take it while it's held; declined → normal dispatch at once", async () => {
    const d = await driver({ autoAdd: false });
    await movingCar(d.id);
    const idle = await driver();
    const req = await request();
    await broadcastRide(prisma, req.id);

    const held = await reload(req.id);
    expect(held).toMatchObject({ status: "REQUESTED", movingStep: "OFFERED", movingHoldDriverId: d.id });
    expect(held.movingHoldUntil!.getTime() - Date.now()).toBeGreaterThan(15_000);
    expect((await requestsForDriver(prisma, idle.id)).map((r) => r.id)).not.toContain(req.id);
    expect((await requestsForDriver(prisma, d.id)).map((r) => r.id)).toContain(req.id);
    expect(await claimIfOpen(prisma, req.id, idle.id)).toBeNull();

    await releaseHold(prisma, req.id, d.id, "DECLINED");
    expect(await reload(req.id)).toMatchObject({ movingStep: "DECLINED", movingHoldDriverId: null, movingHoldUntil: null });
    expect((await requestsForDriver(prisma, idle.id)).map((r) => r.id)).toContain(req.id);
  });

  it("no answer in 20 s: EXPIRED, then normal dispatch", async () => {
    const d = await driver({ autoAdd: false });
    await movingCar(d.id);
    const idle = await driver();
    const req = await request();
    await broadcastRide(prisma, req.id);
    expect(await expireHold(prisma, req.id)).toBe(false); // not yet
    expect(await expireHold(prisma, req.id, new Date(Date.now() + 21_000))).toBe(true);
    expect((await reload(req.id)).movingStep).toBe("EXPIRED");
    expect((await requestsForDriver(prisma, idle.id)).map((r) => r.id)).toContain(req.id);
  });
});

describe("which car", () => {
  it("the best compatible car (least added route); a car the other way never", async () => {
    const wrongWay = await driver({ autoAdd: false });
    await movingCar(wrongWay.id, { to: SOUTH });
    const onWay = await driver({ autoAdd: false });
    await movingCar(onWay.id, { to: NORTH });
    const req = await request();
    await broadcastRide(prisma, req.id);
    expect((await reload(req.id)).movingHoldDriverId).toBe(onWay.id);
  });

  it("a request going the other way: no moving car (NONE), normal dispatch", async () => {
    const d = await driver();
    await movingCar(d.id, { to: NORTH });
    const req = await request({ to: SOUTH });
    await broadcastRide(prisma, req.id);
    expect(await reload(req.id)).toMatchObject({ status: "REQUESTED", movingStep: "NONE", movingHoldUntil: null });
  });

  it("never more seats than free: 2 seats into a car with 3 taken → NONE", async () => {
    const d = await driver();
    await movingCar(d.id, { seats: 3 });
    const req = await request({ seats: 2 });
    await broadcastRide(prisma, req.id);
    expect((await reload(req.id)).movingStep).toBe("NONE");
  });

  it("never Ride alone: a Ride alone request skips the step; a Ride alone car is never a moving car", async () => {
    const d = await driver();
    await movingCar(d.id);
    const lone = await request({ type: "LONE" });
    await broadcastRide(prisma, lone.id);
    expect((await reload(lone.id)).movingStep).toBeNull();

    await prisma.driver.update({ where: { userId: d.id }, data: { isOnline: false } });
    const d2 = await driver();
    await movingCar(d2.id, { type: "LONE" });
    const req = await request();
    await broadcastRide(prisma, req.id);
    expect((await reload(req.id)).movingStep).toBe("NONE");
  });

  it("a scheduled car that has started counts as a moving car", async () => {
    const d = await driver();
    const car = await movingCar(d.id, { booking: "SCHEDULED" });
    const req = await request();
    await broadcastRide(prisma, req.id);
    expect(await reload(req.id)).toMatchObject({ movingStep: "AUTO_ADDED", mergedIntoRideId: car.id });
  });

  it("the step switched off: dispatch as before (no step, no hold)", async () => {
    setMovingFirstForTests({ movingFirstEnabled: false });
    const d = await driver();
    await movingCar(d.id);
    const req = await request();
    await broadcastRide(prisma, req.id);
    expect(await reload(req.id)).toMatchObject({ status: "REQUESTED", movingStep: null, movingHoldUntil: null });
  });
});

describe("HTTP: undo, driver setting, board, admin switches", () => {
  const auth = (id: string, role: "DRIVER" | "ADMIN") => ({ authorization: `Bearer ${signAccessToken({ userId: id, role })}` });

  it("POST undo-add; GET/PATCH /driver/settings", async () => {
    const d = await driver();
    const car = await movingCar(d.id);
    const req = await request();
    await broadcastRide(prisma, req.id);
    const seat = (await reload(car.id)).passengers.find((p) => p.riderId === req.riderId)!;
    const undo = await app.inject({ method: "POST", url: `/rides/${car.id}/passengers/${seat.id}/undo-add`, headers: auth(d.id, "DRIVER"), payload: {} });
    expect(undo.statusCode).toBe(200);
    expect(undo.json()).toMatchObject({ undone: true, requestRideId: req.id });

    expect((await app.inject({ method: "GET", url: "/driver/settings", headers: auth(d.id, "DRIVER") })).json()).toMatchObject({ autoAddRiders: true, autoAddDefault: true });
    const off = await app.inject({ method: "PATCH", url: "/driver/settings", headers: auth(d.id, "DRIVER"), payload: { autoAddRiders: false } });
    expect(off.json().autoAddRiders).toBe(false);
    expect((await prisma.driver.findUniqueOrThrow({ where: { userId: d.id } })).autoAddRiders).toBe(false);
  });

  it("Add on the exclusive offer: the rider joins, gets 'You've joined …' and the pickup estimate", async () => {
    const d = await driver({ autoAdd: false });
    const car = await movingCar(d.id);
    const req = await request();
    await broadcastRide(prisma, req.id);
    expect((await reload(req.id)).movingStep).toBe("OFFERED");
    const add = await app.inject({ method: "POST", url: `/rides/${car.id}/add-passenger`, headers: auth(d.id, "DRIVER"), payload: { requestRideId: req.id, source: "POPUP" } });
    expect(add.statusCode).toBe(200);
    expect(await reload(req.id)).toMatchObject({ status: "CANCELLED", mergedIntoRideId: car.id, movingStep: "OFFERED", movingHoldUntil: null });
    await vi.waitFor(async () => {
      const seat = (await reload(car.id)).passengers.find((p) => p.riderId === req.riderId)!;
      expect(seat.movingJoinEtaMin).toBeGreaterThanOrEqual(1);
    });
    await vi.waitFor(() => expect(push.sent.some((p) => p.kind === "JOINED_CAR" && p.userIds.includes(req.riderId))).toBe(true));
    expect(push.sent.some((p) => p.kind === "DRIVER_ASSIGNED")).toBe(false);
  });

  it("the board puts requests on the driver's way first, marked 'On your way · +N min'", async () => {
    setMovingFirstForTests({ movingFirstEnabled: false });
    const d = await driver();
    await movingCar(d.id);
    const otherWay = await request({ to: SOUTH });
    const onWay = await request();
    const board = (await app.inject({ method: "GET", url: "/driver/requests/board", headers: auth(d.id, "DRIVER") })).json();
    const ids = board.rides.map((r: { rideId: string }) => r.rideId);
    expect(ids.indexOf(onWay.id)).toBeLessThan(ids.indexOf(otherWay.id) === -1 ? Infinity : ids.indexOf(otherWay.id));
    const mark = board.rides.find((r: { rideId: string }) => r.rideId === onWay.id).onYourWay;
    expect(mark.label).toMatch(/^On your way · \+\d+ min$/);
  });

  it("admin: switch the step off and the auto-add default, audit-logged; 7-day step counts", async () => {
    const admin = await createTestUser("RIDER");
    await prisma.user.update({ where: { id: admin.id }, data: { role: "ADMIN" } });
    users.push(admin.id);
    const before = (await app.inject({ method: "GET", url: "/admin/dispatch-settings", headers: auth(admin.id, "ADMIN") })).json();
    expect(before.settings).toMatchObject({ movingFirstEnabled: true, autoAddDefault: true });
    expect(before.movingSteps7d).toEqual(expect.any(Object));
    const put = await app.inject({
      method: "PUT",
      url: "/admin/dispatch-settings",
      headers: auth(admin.id, "ADMIN"),
      payload: { searchWindowSeconds: before.settings.searchWindowSeconds, movingFirstEnabled: false, autoAddDefault: false },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().settings).toMatchObject({ movingFirstEnabled: false, autoAddDefault: false });
    expect(await prisma.adminAuditLog.count({ where: { actor: admin.id, action: "dispatch.moving_first" } })).toBe(1);
  });
});

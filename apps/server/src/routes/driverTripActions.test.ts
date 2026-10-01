/**
 * The driver trip actions the stop-based trip screen relies on, and the
 * failures found with the fake-rider simulator (2026-10-01):
 *
 * - cancelling the last waiting rider after the others were dropped off was
 *   refused and left the ride stuck IN_PROGRESS;
 * - an action retried after a timeout (the first attempt had landed) was
 *   refused as an "invalid transition" — every action is now a no-op repeat;
 * - refusals said "Invalid transition from current passenger status"; they
 *   now say what happened, with a code.
 */
import { afterEach, afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { prisma } from "../db/prisma";
import { registerDriverRoutes } from "./driver";
import { signAccessToken } from "../services/auth/tokens";
import { cleanupDriver, createTestDriver, createTestRide, createTestUser } from "../services/ride/testFixtures";
import * as rideSocket from "../realtime/rideSocket";
import { haversineDistanceMeters } from "@rida/shared";

vi.mock("../services/sms/sendSms", () => ({ sendSms: vi.fn().mockResolvedValue({ success: true }) }));

let app: FastifyInstance;
const rideIds: string[] = [];
const driverIds: string[] = [];

beforeAll(async () => {
  app = Fastify();
  registerDriverRoutes(app, prisma);
  await app.ready();
});

afterEach(async () => {
  const rides = await prisma.ride.findMany({ where: { id: { in: rideIds } }, include: { passengers: true } });
  const userIds = new Set(rides.flatMap((r) => [r.riderId, ...r.passengers.map((p) => p.riderId)]));
  await prisma.ridePassenger.deleteMany({ where: { rideId: { in: rideIds } } });
  await prisma.commissionLedger.deleteMany({ where: { rideId: { in: rideIds } } });
  await prisma.ride.updateMany({ where: { id: { in: rideIds } }, data: { mergedIntoRideId: null } });
  await prisma.ride.deleteMany({ where: { id: { in: rideIds } } });
  await prisma.user.deleteMany({ where: { id: { in: [...userIds] } } });
  rideIds.length = 0;
  while (driverIds.length) await cleanupDriver(driverIds.pop()!);
});

afterAll(async () => {
  await app.close();
});

async function driverWithCar(statuses: Array<"WAITING" | "ARRIVED" | "PICKED_UP" | "DROPPED_OFF" | "CANCELLED">, rideStatus: "MATCHED" | "ARRIVED" | "IN_PROGRESS" = "MATCHED", type: "SHARED" | "LONE" = "SHARED") {
  const { user } = await createTestDriver({ isOnline: true, isApproved: true });
  driverIds.push(user.id);
  const riders: Array<{ id: string }> = [];
  for (let i = 0; i < statuses.length; i++) riders.push(await createTestUser("RIDER"));
  const { ride } = await createTestRide({
    type,
    status: rideStatus,
    driverId: user.id,
    occupancy: statuses.filter((s) => s !== "DROPPED_OFF" && s !== "CANCELLED").length,
    passengers: statuses.map((status, i) => ({ riderId: riders[i]!.id, status, lockedFare: 500 })),
  });
  rideIds.push(ride.id);
  const seats = [...ride.passengers].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const token = signAccessToken({ userId: user.id, role: "DRIVER" });
  const act = (seatId: string, action: string) =>
    app.inject({ method: "POST", url: `/rides/${ride.id}/passengers/${seatId}/${action}`, headers: { authorization: `Bearer ${token}` } });
  return { driver: user, ride, seats, token, act };
}

describe("passenger actions", () => {
  it("cancelling the last waiting rider after the others were dropped off completes the trip (was: refused, ride stuck)", async () => {
    const { ride, seats, act } = await driverWithCar(["DROPPED_OFF", "DROPPED_OFF", "WAITING"], "IN_PROGRESS");
    const res = await act(seats[2]!.id, "cancel");
    expect(res.statusCode).toBe(200);
    const after = await prisma.ride.findUniqueOrThrow({ where: { id: ride.id } });
    expect(after.status).toBe("COMPLETED");
    expect(after.completedAt).not.toBeNull();
    await vi.waitFor(async () => {
      expect(await prisma.commissionLedger.count({ where: { rideId: ride.id } })).toBe(1);
    });
  });

  it("repeating an action that already landed answers 200 and changes nothing", async () => {
    const { seats, act } = await driverWithCar(["WAITING"]);
    const first = await act(seats[0]!.id, "arrived");
    const arrivedAt = (await prisma.ridePassenger.findUniqueOrThrow({ where: { id: seats[0]!.id } })).arrivedAt;
    const again = await act(seats[0]!.id, "arrived");
    expect([first.statusCode, again.statusCode]).toEqual([200, 200]);
    const seat = await prisma.ridePassenger.findUniqueOrThrow({ where: { id: seats[0]!.id } });
    expect(seat.status).toBe("ARRIVED");
    expect(seat.arrivedAt).toEqual(arrivedAt);
  });

  it("the first 'I'm here' moves the ride to ARRIVED and stamps the rider's wait timer", async () => {
    const { ride, seats, act } = await driverWithCar(["WAITING"], "MATCHED", "LONE");
    expect((await act(seats[0]!.id, "arrived")).statusCode).toBe(200);
    const after = await prisma.ride.findUniqueOrThrow({ where: { id: ride.id }, include: { passengers: true } });
    expect(after.status).toBe("ARRIVED");
    expect(after.passengers[0]!.arrivedAt).toBeInstanceOf(Date);
  });

  it("a Ride-alone trip runs start to finish through the passenger actions", async () => {
    const { ride, seats, act } = await driverWithCar(["WAITING"], "MATCHED", "LONE");
    for (const action of ["arrived", "pickup", "dropoff"]) {
      expect((await act(seats[0]!.id, action)).statusCode, action).toBe(200);
    }
    expect((await prisma.ride.findUniqueOrThrow({ where: { id: ride.id } })).status).toBe("COMPLETED");
  });

  it("refuses in plain words, with a code", async () => {
    const { seats, act } = await driverWithCar(["WAITING", "PICKED_UP"], "IN_PROGRESS");
    const dropWaiting = await act(seats[0]!.id, "dropoff");
    expect(dropWaiting.statusCode).toBe(409);
    expect(dropWaiting.json()).toEqual({ code: "INVALID_PASSENGER_STATE", error: "This rider hasn't been picked up yet." });

    const cancelOnboard = await act(seats[1]!.id, "cancel");
    expect(cancelOnboard.json().error).toBe("This rider is already in the car. Drop them off instead.");

    const wrongRide = await app.inject({
      method: "POST",
      url: `/rides/not-this-ride/passengers/${seats[0]!.id}/arrived`,
      headers: { authorization: `Bearer ${signAccessToken({ userId: "someone", role: "DRIVER" })}` },
    });
    expect(wrongRide.statusCode).toBe(404);
    expect(wrongRide.json().code).toBe("PASSENGER_NOT_FOUND");
  });

  it("another driver cannot act on the trip", async () => {
    const { seats, ride } = await driverWithCar(["WAITING"]);
    const { user: other } = await createTestDriver({ isOnline: true, isApproved: true });
    driverIds.push(other.id);
    const res = await app.inject({
      method: "POST",
      url: `/rides/${ride.id}/passengers/${seats[0]!.id}/arrived`,
      headers: { authorization: `Bearer ${signAccessToken({ userId: other.id, role: "DRIVER" })}` },
    });
    expect(res.statusCode).toBe(403);
    expect((await prisma.ridePassenger.findUniqueOrThrow({ where: { id: seats[0]!.id } })).status).toBe("WAITING");
  });
});

describe("rider didn't show", () => {
  it("is refused before 3 minutes and allowed after, marking the seat as a no-show", async () => {
    const { ride, seats, act } = await driverWithCar(["WAITING"], "MATCHED", "LONE");
    await act(seats[0]!.id, "arrived");

    const early = await act(seats[0]!.id, "no-show");
    expect(early.statusCode).toBe(409);
    expect(early.json()).toMatchObject({ code: "NO_SHOW_TOO_EARLY" });
    expect(early.json().error).toMatch(/in 3 min/);

    // Wind the clock back instead of waiting.
    await prisma.ridePassenger.update({
      where: { id: seats[0]!.id },
      data: { arrivedAt: new Date(Date.now() - 3 * 60_000 - 1_000) },
    });
    const late = await act(seats[0]!.id, "no-show");
    expect(late.statusCode).toBe(200);
    const seat = await prisma.ridePassenger.findUniqueOrThrow({ where: { id: seats[0]!.id } });
    expect(seat.status).toBe("CANCELLED");
    expect(seat.noShowAt).toBeInstanceOf(Date);
    expect((await prisma.ride.findUniqueOrThrow({ where: { id: ride.id } })).status).toBe("CANCELLED");
  });

  it("is not a way round 'no cancelling after I'm here' — plain cancel stays refused", async () => {
    const { seats, act } = await driverWithCar(["ARRIVED"], "ARRIVED");
    const res = await act(seats[0]!.id, "cancel");
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/Rider didn't show/);
  });
});

describe("claim and add-passenger", () => {
  async function openShared() {
    const rider = await createTestUser("RIDER");
    const { ride } = await createTestRide({
      type: "SHARED",
      status: "REQUESTED",
      broadcastStartedAt: new Date(),
      passengers: [{ riderId: rider.id, lockedFare: 500 }],
    });
    rideIds.push(ride.id);
    return ride;
  }

  it("claiming a ride you already hold answers 200 (a retry after a timeout)", async () => {
    const { user } = await createTestDriver({ isOnline: true, isApproved: true });
    driverIds.push(user.id);
    const token = signAccessToken({ userId: user.id, role: "DRIVER" });
    const ride = await openShared();
    const claim = () => app.inject({ method: "POST", url: `/rides/${ride.id}/claim`, headers: { authorization: `Bearer ${token}` } });
    expect((await claim()).statusCode).toBe(200);
    const again = await claim();
    expect(again.statusCode).toBe(200);
    expect(again.json().ride.id).toBe(ride.id);
  });

  it("losing the race is a plain refusal", async () => {
    const ride = await openShared();
    const drivers: string[] = [];
    for (let i = 0; i < 2; i++) {
      const { user } = await createTestDriver({ isOnline: true, isApproved: true });
      driverIds.push(user.id);
      drivers.push(signAccessToken({ userId: user.id, role: "DRIVER" }));
    }
    const results = await Promise.all(
      drivers.map((t) => app.inject({ method: "POST", url: `/rides/${ride.id}/claim`, headers: { authorization: `Bearer ${t}` } })),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.statusCode === 409)!.json()).toMatchObject({ code: "RIDE_NOT_AVAILABLE" });
  });

  it("adding a rider twice answers 200 once added; two adds into the last seat can't overfill the car", async () => {
    const { ride: anchor, token } = await driverWithCar(["WAITING", "WAITING", "WAITING"]);
    const [x, y] = [await openShared(), await openShared()];
    const add = (requestRideId: string) =>
      app.inject({
        method: "POST",
        url: `/rides/${anchor.id}/add-passenger`,
        headers: { authorization: `Bearer ${token}` },
        payload: { requestRideId },
      });

    const both = await Promise.all([add(x.id), add(y.id)]);
    expect(both.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(both.find((r) => r.statusCode === 409)!.json()).toMatchObject({ code: "CAR_FULL" });
    const winner = both[0]!.statusCode === 200 ? x : y;

    const retry = await add(winner.id);
    expect(retry.statusCode).toBe(200);
    expect(await prisma.ridePassenger.count({ where: { rideId: anchor.id } })).toBe(4);
    expect((await prisma.ride.findUniqueOrThrow({ where: { id: anchor.id } })).occupancy).toBe(4);
  });
});

describe("add-rider route preview", () => {
  async function openShared(pickupZoneId?: string, dropoffZoneId?: string) {
    const rider = await createTestUser("RIDER");
    const { ride } = await createTestRide({
      type: "SHARED",
      status: "REQUESTED",
      broadcastStartedAt: new Date(),
      passengers: [{ riderId: rider.id, lockedFare: 500 }],
      ...(pickupZoneId ? { pickupZoneId } : {}),
      ...(dropoffZoneId ? { dropoffZoneId } : {}),
    });
    rideIds.push(ride.id);
    return ride;
  }
  const preview = (rideId: string, token: string, requestRideId: string, extra = "") =>
    app.inject({
      method: "GET",
      url: `/rides/${rideId}/add-preview?requestRideId=${requestRideId}${extra}`,
      headers: { authorization: `Bearer ${token}` },
    });

  it("shows where the new rider slots in, both routes, the added time and the extra fare", async () => {
    const { ride: car, token } = await driverWithCar(["WAITING"]);
    const zones = await prisma.zone.findMany({ take: 3, orderBy: { name: "asc" } });
    const request = await openShared(zones[1]!.id, zones[2]!.id);

    const res = await preview(car.id, token, request.id, `&lat=${zones[0]!.latitude}&lng=${zones[0]!.longitude}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ requestRideId: request.id, farePesewas: 500, driverSharePesewas: 425 });
    expect(body.addedMinutes).toBeGreaterThanOrEqual(1);
    expect(body.stops).toHaveLength(4);
    const newStops = body.stops.filter((s: { isNew: boolean }) => s.isNew);
    expect(newStops.map((s: { kind: string; zoneId: string }) => `${s.kind}@${s.zoneId}`)).toEqual([
      `PICKUP@${zones[1]!.id}`,
      `DROPOFF@${zones[2]!.id}`,
    ]);
    expect(body.dropoffIndex).toBeGreaterThan(body.pickupIndex);
    expect(typeof body.proposedPolyline).toBe("string");
    expect(body.proposedPolyline.length).toBeGreaterThan(body.currentPolyline.length);
    expect(Date.parse(body.expiresAt) - request.broadcastStartedAt!.getTime()).toBe(90_000);
    // Read-only: nothing changed.
    expect((await prisma.ride.findUniqueOrThrow({ where: { id: request.id } })).status).toBe("REQUESTED");
  });

  it("refuses when the request is gone or the car has left, so the app never previews an add that would fail", async () => {
    const { ride: car, token } = await driverWithCar(["WAITING"]);
    const request = await openShared();
    await prisma.ride.update({ where: { id: request.id }, data: { status: "CANCELLED", cancelReason: "RIDER_CANCELLED" } });
    expect((await preview(car.id, token, request.id)).json()).toMatchObject({ code: "REQUEST_UNAVAILABLE" });

    // A moving car can take riders now (sketch 6); a finished one can't.
    const moving = await driverWithCar(["PICKED_UP"], "IN_PROGRESS");
    const another = await openShared();
    expect((await preview(moving.ride.id, moving.token, another.id)).statusCode).toBe(200);
    await prisma.ride.update({ where: { id: moving.ride.id }, data: { status: "COMPLETED" } });
    expect((await preview(moving.ride.id, moving.token, another.id)).json()).toMatchObject({ code: "CAR_CLOSED" });
  });
});

describe("adding a rider while the car is moving (IN_PROGRESS)", () => {
  async function openRequest(pickupZoneId: string, dropoffZoneId: string) {
    const rider = await createTestUser("RIDER");
    const { ride } = await createTestRide({
      type: "SHARED",
      status: "REQUESTED",
      broadcastStartedAt: new Date(),
      pickupZoneId,
      dropoffZoneId,
      passengers: [{ riderId: rider.id, lockedFare: 500 }],
    });
    rideIds.push(ride.id);
    return ride;
  }
  const add = (rideId: string, token: string, requestRideId: string) =>
    app.inject({
      method: "POST",
      url: `/rides/${rideId}/add-passenger`,
      headers: { authorization: `Bearer ${token}` },
      payload: { requestRideId },
    });

  afterEach(async () => {
    await prisma.zoneRoute.deleteMany({ where: { provider: "test" } });
    vi.restoreAllMocks();
  });

  it("adds the rider without touching the trip's state or anyone's fare, and tells riders on board", async () => {
    const notices = vi.spyOn(rideSocket, "emitToRider");
    const { ride, seats, token } = await driverWithCar(["PICKED_UP"], "IN_PROGRESS");
    await prisma.ride.update({ where: { id: ride.id }, data: { departedAt: new Date("2026-10-02T09:00:00Z") } });
    await prisma.ridePassenger.update({ where: { id: seats[0]!.id }, data: { lockedFare: 450 } });
    const request = await openRequest(ride.pickupZoneId, ride.dropoffZoneId);

    const res = await add(ride.id, token, request.id);
    expect(res.statusCode).toBe(200);

    const after = await prisma.ride.findUniqueOrThrow({ where: { id: ride.id }, include: { passengers: true } });
    expect(after.status).toBe("IN_PROGRESS");
    expect(after.departedAt).toEqual(new Date("2026-10-02T09:00:00Z"));
    expect(after.passengers.find((p) => p.id === seats[0]!.id)!.lockedFare).toBe(450); // frozen
    const newcomer = after.passengers.find((p) => p.id !== seats[0]!.id)!;
    expect(newcomer).toMatchObject({ status: "WAITING", lockedFare: 500 });

    const notice = notices.mock.calls.find(([, event]) => event === "ride:car_notice");
    expect(notice?.[0]).toBe(seats[0]!.riderId);
    expect((notice?.[2] as { message: string }).message).toMatch(/^Picking up 1 more rider on the way · ~\d+ min$/);
  });

  it("refuses a rider whose detour makes riders in the car more than 5 minutes late", async () => {
    const { ride, seats, token } = await driverWithCar(["PICKED_UP"], "IN_PROGRESS");
    // Driver at A. Ama (in the car) is going to B. The new rider is picked
    // up right here at A and goes to C, which is nearer than B — so their
    // drop-off comes first — and the road from C on to B takes 7 minutes.
    const all = await prisma.zone.findMany();
    const A = all[0]!;
    const [C, B] = all
      .filter((z) => z.id !== A.id)
      .sort((x, y) => haversineDistanceMeters(A, x) - haversineDistanceMeters(A, y));
    await prisma.ridePassenger.update({ where: { id: seats[0]!.id }, data: { pickupZoneId: A.id, dropoffZoneId: B!.id } });
    await prisma.zoneRoute.create({
      data: { fromZoneId: C!.id, toZoneId: B!.id, polyline: "_p~iF~ps|U", distanceMeters: 4000, durationSeconds: 420, provider: "test" },
    });
    const request = await openRequest(A.id, C!.id);
    const payload = { requestRideId: request.id, lat: A.latitude, lng: A.longitude };

    const previewRes = await app.inject({
      method: "GET",
      url: `/rides/${ride.id}/add-preview?requestRideId=${request.id}&lat=${A.latitude}&lng=${A.longitude}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(previewRes.json()).toMatchObject({ code: "DETOUR_TOO_LONG" });

    const res = await app.inject({ method: "POST", url: `/rides/${ride.id}/add-passenger`, headers: { authorization: `Bearer ${token}` }, payload });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      code: "DETOUR_TOO_LONG",
      error: "Adding this rider would make the riders in your car more than 5 minutes late.",
    });
    // Nothing kept: the request is still open, the car unchanged.
    expect((await prisma.ride.findUniqueOrThrow({ where: { id: request.id } })).status).toBe("REQUESTED");
    expect(await prisma.ridePassenger.count({ where: { rideId: ride.id } })).toBe(1);
  });

  it("counts seats by riders in the car: a dropped-off rider frees theirs; four riders is full", async () => {
    const roomy = await driverWithCar(["DROPPED_OFF", "PICKED_UP", "PICKED_UP", "WAITING"], "IN_PROGRESS");
    const r1 = await openRequest(roomy.ride.pickupZoneId, roomy.ride.dropoffZoneId);
    expect((await add(roomy.ride.id, roomy.token, r1.id)).statusCode).toBe(200);

    const r2 = await openRequest(roomy.ride.pickupZoneId, roomy.ride.dropoffZoneId);
    const full = await add(roomy.ride.id, roomy.token, r2.id);
    expect(full.statusCode).toBe(409);
    expect(full.json()).toMatchObject({ code: "CAR_FULL" });
  });
});

describe("rider didn't show, through the passenger cancel", () => {
  it("cancel with reason NO_SHOW works three minutes after arriving, and not before", async () => {
    const { ride, seats, token } = await driverWithCar(["WAITING"], "MATCHED", "LONE");
    const cancel = (reason?: string) =>
      app.inject({
        method: "POST",
        url: `/rides/${ride.id}/passengers/${seats[0]!.id}/cancel`,
        headers: { authorization: `Bearer ${token}` },
        payload: reason ? { reason } : {},
      });
    await app.inject({ method: "POST", url: `/rides/${ride.id}/passengers/${seats[0]!.id}/arrived`, headers: { authorization: `Bearer ${token}` } });

    expect((await cancel()).json()).toMatchObject({ code: "INVALID_PASSENGER_STATE" }); // plain cancel: not after "I'm here"
    expect((await cancel("NO_SHOW")).json()).toMatchObject({ code: "NO_SHOW_TOO_EARLY" });

    await prisma.ridePassenger.update({ where: { id: seats[0]!.id }, data: { arrivedAt: new Date(Date.now() - 181_000) } });
    expect((await cancel("NO_SHOW")).statusCode).toBe(200);
    const seat = await prisma.ridePassenger.findUniqueOrThrow({ where: { id: seats[0]!.id } });
    expect(seat.status).toBe("CANCELLED");
    expect(seat.noShowAt).toBeInstanceOf(Date);
  });
});

describe("leaving the service area", () => {
  it("PATCH /driver/zone with null clears the driver's zone, so no requests reach them", async () => {
    const { user } = await createTestDriver({ isOnline: true, isApproved: true });
    driverIds.push(user.id);
    const zone = await prisma.zone.findFirstOrThrow();
    await prisma.driver.update({ where: { userId: user.id }, data: { currentZoneId: zone.id } });
    const res = await app.inject({
      method: "PATCH",
      url: "/driver/zone",
      headers: { authorization: `Bearer ${signAccessToken({ userId: user.id, role: "DRIVER" })}` },
      payload: { zoneId: null },
    });
    expect(res.statusCode).toBe(200);
    expect((await prisma.driver.findUniqueOrThrow({ where: { userId: user.id } })).currentZoneId).toBeNull();
  });
});

describe("a full two-rider shared trip, end to end", () => {
  it("claim → add → arrive, pick up and drop off both → completed, with the cash commission for two riders", async () => {
    const { user: driver } = await createTestDriver({ isOnline: true, isApproved: true });
    driverIds.push(driver.id);
    const token = signAccessToken({ userId: driver.id, role: "DRIVER" });
    const call = (method: "GET" | "POST", url: string, payload?: object) =>
      app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });
    const zones = await prisma.zone.findMany({ take: 3, orderBy: { name: "asc" } });

    const open = async (from: string, to: string) => {
      const rider = await createTestUser("RIDER");
      const { ride } = await createTestRide({
        type: "SHARED",
        status: "REQUESTED",
        broadcastStartedAt: new Date(),
        pickupZoneId: from,
        dropoffZoneId: to,
        passengers: [{ riderId: rider.id, lockedFare: 500 }],
      });
      rideIds.push(ride.id);
      return ride;
    };
    const ama = await open(zones[0]!.id, zones[2]!.id);
    const kofi = await open(zones[1]!.id, zones[2]!.id);

    expect((await call("POST", `/rides/${ama.id}/claim`)).statusCode).toBe(200);
    expect((await call("GET", `/rides/${ama.id}/add-preview?requestRideId=${kofi.id}`)).statusCode).toBe(200);
    expect((await call("POST", `/rides/${ama.id}/add-passenger`, { requestRideId: kofi.id })).statusCode).toBe(200);

    const active = (await call("GET", "/driver/rides/active")).json().ride;
    expect(active.passengers).toHaveLength(2);
    const [seatA, seatK] = active.passengers as Array<{ id: string }>;
    const step = async (seat: string, action: string) =>
      expect((await call("POST", `/rides/${ama.id}/passengers/${seat}/${action}`)).statusCode, `${action} ${seat}`).toBe(200);

    await step(seatA!.id, "arrived");
    expect((await prisma.ride.findUniqueOrThrow({ where: { id: ama.id } })).status).toBe("ARRIVED");
    await step(seatA!.id, "pickup");
    expect((await prisma.ride.findUniqueOrThrow({ where: { id: ama.id } })).status).toBe("IN_PROGRESS"); // departs at the first pickup
    await step(seatK!.id, "arrived");
    await step(seatK!.id, "pickup");
    await step(seatA!.id, "dropoff");
    expect((await prisma.ride.findUniqueOrThrow({ where: { id: ama.id } })).status).toBe("IN_PROGRESS");
    await step(seatK!.id, "dropoff");

    const done = await prisma.ride.findUniqueOrThrow({ where: { id: ama.id }, include: { passengers: true } });
    expect(done.status).toBe("COMPLETED");
    expect(done.passengers.map((p) => [p.status, p.fareCharged])).toEqual([
      ["DROPPED_OFF", 500],
      ["DROPPED_OFF", 500],
    ]);
    await vi.waitFor(async () => {
      const ledger = await prisma.commissionLedger.findUnique({ where: { rideId: ama.id } });
      expect(ledger?.amountPesewas).toBe(150); // 15% of 2 × GH₵5
    });
    expect((await call("GET", "/driver/rides/active")).json().ride).toBeNull();
  });
});

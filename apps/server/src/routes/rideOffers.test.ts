/**
 * Ride offers (2026-10): each request pops up for a driver as one offer.
 *
 * - Two drivers accepting the same ride at the same moment: exactly one
 *   wins; the other is told "Ride taken by another driver".
 * - A declined or timed-out ride is never offered to that driver again —
 *   not in the list, not in a re-broadcast, not mid-trip — but stays open
 *   for everyone else; the reason is kept for stats.
 * - Offers carry names and numbers only: no coordinates, no note.
 * - Drivers on a trip get no Home offers; a full car gets no mid-trip ones.
 * - When a request goes (taken, cancelled, expired), every driver it was
 *   offered to hears `ride:offer_closed`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { prisma } from "../db/prisma";
import { registerDriverRoutes } from "./driver";
import { registerRideRoutes } from "./rides";
import { signAccessToken } from "../services/auth/tokens";
import { cleanupDriver, createTestDriver, createTestRide, createTestUser, getTestZones } from "../services/ride/testFixtures";
import * as rideSocket from "../realtime/rideSocket";
import { broadcastRide } from "../services/ride/dispatch";
import { processTimeouts } from "../services/ride/timeouts";
import { DISPATCH_WINDOW_MS, getSharedFarePerRider, splitFare } from "@rida/shared";

vi.mock("../services/sms/sendSms", () => ({ sendSms: vi.fn().mockResolvedValue({ success: true }) }));

let app: FastifyInstance;
const rideIds: string[] = [];
const driverIds: string[] = [];
const userIds: string[] = [];

beforeAll(async () => {
  app = Fastify();
  registerDriverRoutes(app, prisma);
  registerRideRoutes(app, prisma);
  await app.ready();
});

afterEach(async () => {
  vi.restoreAllMocks();
  const rides = await prisma.ride.findMany({ where: { id: { in: rideIds } }, include: { passengers: true } });
  const riders = new Set(rides.flatMap((r) => [r.riderId, ...r.passengers.map((p) => p.riderId)]));
  await prisma.ridePassenger.deleteMany({ where: { rideId: { in: rideIds } } });
  await prisma.ride.updateMany({ where: { id: { in: rideIds } }, data: { mergedIntoRideId: null } });
  await prisma.ride.deleteMany({ where: { id: { in: rideIds } } });
  await prisma.user.deleteMany({ where: { id: { in: [...riders, ...userIds] } } });
  rideIds.length = 0;
  userIds.length = 0;
  while (driverIds.length) await cleanupDriver(driverIds.pop()!);
});

afterAll(async () => {
  await app.close();
});

async function driver(zoneId: string) {
  const { user } = await createTestDriver({ isOnline: true, isApproved: true, currentZoneId: zoneId });
  driverIds.push(user.id);
  return { id: user.id, auth: { authorization: `Bearer ${signAccessToken({ userId: user.id, role: "DRIVER" })}` } };
}

/** An open request, optionally with exact pins and a note (as current rider apps book). */
async function request(type: "LONE" | "SHARED" = "LONE", pins = false) {
  const { pickup, dropoff } = await getTestZones();
  const rider = await createTestUser("RIDER");
  const { ride } = await createTestRide({
    type,
    status: "REQUESTED",
    broadcastStartedAt: new Date(),
    passengers: [{ riderId: rider.id, lockedFare: 500 }],
  });
  rideIds.push(ride.id);
  if (pins) {
    const data = {
      pickupLat: 5.652011,
      pickupLng: -0.187047,
      pickupLabel: "Balme Library",
      dropoffLat: 5.642503,
      dropoffLng: -0.186282,
      dropoffLabel: "Night Market",
      pickupNote: "Blue shirt by the fountain",
    };
    await prisma.ride.update({ where: { id: ride.id }, data });
    await prisma.ridePassenger.updateMany({ where: { rideId: ride.id }, data });
  }
  return { ride, rider, pickup, dropoff };
}

const eligible = async (auth: Record<string, string>, query = "") =>
  (await app.inject({ method: "GET", url: `/driver/rides/eligible${query}`, headers: auth })).json().rides as Array<Record<string, unknown>>;

describe("two drivers accept the same ride at the same moment", () => {
  it("exactly one wins; the other is told it was taken", async () => {
    const { ride } = await request();
    const a = await driver(ride.pickupZoneId);
    const b = await driver(ride.pickupZoneId);
    const [ra, rb] = await Promise.all([
      app.inject({ method: "POST", url: `/rides/${ride.id}/claim`, headers: a.auth }),
      app.inject({ method: "POST", url: `/rides/${ride.id}/claim`, headers: b.auth }),
    ]);
    const codes = [ra.statusCode, rb.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    const loser = ra.statusCode === 409 ? ra : rb;
    expect(loser.json()).toEqual({ code: "RIDE_NOT_AVAILABLE", reason: "TAKEN", error: "Ride taken by another driver." });
    const winnerId = ra.statusCode === 200 ? a.id : b.id;
    expect((await prisma.ride.findUniqueOrThrow({ where: { id: ride.id } })).driverId).toBe(winnerId);
  });

  it("an accept racing another driver's mid-trip add: one gets the rider", async () => {
    const { ride } = await request("SHARED");
    const a = await driver(ride.pickupZoneId);
    // Driver B is on a shared trip with a free seat.
    const b = await driver(ride.pickupZoneId);
    const anchorRider = await createTestUser("RIDER");
    const { ride: car } = await createTestRide({
      type: "SHARED",
      status: "MATCHED",
      driverId: b.id,
      passengers: [{ riderId: anchorRider.id, status: "WAITING", lockedFare: 500 }],
    });
    rideIds.push(car.id);
    const [claim, add] = await Promise.all([
      app.inject({ method: "POST", url: `/rides/${ride.id}/claim`, headers: a.auth }),
      app.inject({ method: "POST", url: `/rides/${car.id}/add-passenger`, headers: b.auth, payload: { requestRideId: ride.id } }),
    ]);
    expect([claim.statusCode, add.statusCode].sort()).toEqual([200, 409]);
    if (claim.statusCode === 409) expect(claim.json()).toMatchObject({ reason: "TAKEN" });
  });

  it("says so when the rider cancelled, or the request expired", async () => {
    const { ride } = await request();
    const a = await driver(ride.pickupZoneId);
    await prisma.ride.update({ where: { id: ride.id }, data: { status: "CANCELLED", cancelReason: "RIDER_CANCELLED" } });
    expect((await app.inject({ method: "POST", url: `/rides/${ride.id}/claim`, headers: a.auth })).json()).toMatchObject({
      reason: "CANCELLED",
      error: "The rider cancelled this request.",
    });
    await prisma.ride.update({ where: { id: ride.id }, data: { status: "AWAITING_RIDER_DECISION", cancelReason: null } });
    expect((await app.inject({ method: "POST", url: `/rides/${ride.id}/claim`, headers: a.auth })).json()).toMatchObject({
      reason: "EXPIRED",
    });
  });
});

describe("a declined or timed-out ride is never offered to that driver again", () => {
  for (const reason of ["DECLINED", "TIMED_OUT"] as const) {
    it(`${reason}: gone from that driver's list and re-broadcasts, still offered to others, reason kept`, async () => {
      const { ride } = await request();
      const a = await driver(ride.pickupZoneId);
      const b = await driver(ride.pickupZoneId);
      expect((await eligible(a.auth)).map((r) => r.rideId)).toContain(ride.id);

      const res = await app.inject({ method: "POST", url: `/rides/${ride.id}/reject`, headers: a.auth, payload: { reason } });
      expect(res.statusCode).toBe(200);
      expect((await eligible(a.auth)).map((r) => r.rideId)).not.toContain(ride.id);
      expect((await eligible(b.auth)).map((r) => r.rideId)).toContain(ride.id);

      // A re-broadcast (e.g. the rider chose "Keep waiting") skips driver A.
      const emit = vi.spyOn(rideSocket, "emitDriverBroadcast").mockImplementation(() => {});
      await broadcastRide(prisma, ride.id);
      const recipients = emit.mock.calls.at(-1)?.[0] ?? [];
      expect(recipients).toContain(b.id);
      expect(recipients).not.toContain(a.id);

      const row = await prisma.rideRejection.findUniqueOrThrow({ where: { rideId_driverUserId: { rideId: ride.id, driverUserId: a.id } } });
      expect(row.reason).toBe(reason);
      // A second answer (a retry, or a tap racing the timeout) doesn't change it.
      await app.inject({ method: "POST", url: `/rides/${ride.id}/reject`, headers: a.auth, payload: { reason: reason === "DECLINED" ? "TIMED_OUT" : "DECLINED" } });
      expect((await prisma.rideRejection.findUniqueOrThrow({ where: { id: row.id } })).reason).toBe(reason);
    });
  }

  it("refuses an unknown reason", async () => {
    const { ride } = await request();
    const a = await driver(ride.pickupZoneId);
    expect((await app.inject({ method: "POST", url: `/rides/${ride.id}/reject`, headers: a.auth, payload: { reason: "BORED" } })).statusCode).toBe(400);
  });

  it("a declined rider isn't offered mid-trip either", async () => {
    const { ride: open } = await request("SHARED");
    const b = await driver(open.pickupZoneId);
    const anchorRider = await createTestUser("RIDER");
    const { ride: car } = await createTestRide({
      type: "SHARED",
      status: "MATCHED",
      driverId: b.id,
      passengers: [{ riderId: anchorRider.id, status: "WAITING", lockedFare: 500 }],
    });
    rideIds.push(car.id);
    const suggestions = async () =>
      ((await app.inject({ method: "GET", url: `/rides/${car.id}/fill-suggestions`, headers: b.auth })).json().suggestions as Array<{ requestRideId: string }>).map((s) => s.requestRideId);
    expect(await suggestions()).toContain(open.id);
    await app.inject({ method: "POST", url: `/rides/${open.id}/reject`, headers: b.auth, payload: { reason: "DECLINED" } });
    expect(await suggestions()).not.toContain(open.id);
  });
});

describe("offer payloads: names and numbers only", () => {
  it("the offer has the card's details and no coordinates, no note", async () => {
    const { ride } = await request("LONE", true);
    const a = await driver(ride.pickupZoneId);
    // The rider has been rated by drivers before.
    const otherDriver = await createTestUser("DRIVER");
    userIds.push(otherDriver.id);
    const pastRide = await createTestRide({ type: "LONE", status: "COMPLETED" });
    rideIds.push(pastRide.ride.id);
    await prisma.rating.create({ data: { rideId: pastRide.ride.id, raterId: otherDriver.id, rateeId: ride.riderId, stars: 4 } });

    const res = await app.inject({ method: "GET", url: "/driver/rides/eligible?lat=5.6505&lng=-0.1870", headers: a.auth });
    const offer = (res.json().rides as Array<Record<string, unknown>>).find((r) => r.rideId === ride.id)!;
    expect(offer).toMatchObject({
      pickupPlaceName: "Balme Library",
      dropoffPlaceName: "Night Market",
      type: "LONE",
      seats: 1,
      riderRating: 4,
      offerSeconds: 15,
    });
    for (const key of ["pickupDistanceMeters", "pickupMinutes", "tripDistanceMeters", "tripMinutes"]) {
      expect(typeof offer[key]).toBe("number");
    }
    expect(Date.parse(offer.expiresAt as string) - Date.parse(offer.createdAt as string)).toBeLessThanOrEqual(DISPATCH_WINDOW_MS + 1000);

    // No coordinates or note anywhere in the response — not as keys, not as values.
    const text = res.body;
    for (const key of ["latitude", "longitude", "Lat\"", "Lng\"", "pickupNote", "note"]) expect(text).not.toContain(key);
    for (const value of ["5.652011", "-0.187047", "5.642503", "-0.186282", "Blue shirt"]) expect(text).not.toContain(value);
  });

  it("the broadcast and the offer-closed event carry no coordinates either", async () => {
    const { ride } = await request("LONE", true);
    const a = await driver(ride.pickupZoneId);
    const sent: unknown[] = [];
    vi.spyOn(rideSocket, "emitDriverBroadcast").mockImplementation((_ids, p) => void sent.push(p));
    vi.spyOn(rideSocket, "emitOfferClosed").mockImplementation((_ids, p) => void sent.push(p));
    await broadcastRide(prisma, ride.id);
    await app.inject({ method: "POST", url: `/rides/${ride.id}/claim`, headers: a.auth });
    await vi.waitFor(() => expect(sent.length).toBe(2));
    const text = JSON.stringify(sent);
    for (const value of ["5.652011", "-0.187047", "Blue shirt", "latitude", "Lat\""]) expect(text).not.toContain(value);
  });
});

describe("who is offered rides", () => {
  it("a driver already on a trip gets no Home offers", async () => {
    const { ride } = await request();
    const a = await driver(ride.pickupZoneId);
    expect((await eligible(a.auth)).length).toBeGreaterThan(0);
    const { ride: mine } = await createTestRide({ type: "LONE", status: "MATCHED", driverId: a.id });
    rideIds.push(mine.id);
    expect(await eligible(a.auth)).toEqual([]);
  });

  it("a full shared car is offered no riders mid-trip", async () => {
    const { ride: open } = await request("SHARED");
    const b = await driver(open.pickupZoneId);
    const riders = await Promise.all([1, 2, 3, 4].map(() => createTestUser("RIDER")));
    const { ride: car } = await createTestRide({
      type: "SHARED",
      status: "IN_PROGRESS",
      driverId: b.id,
      occupancy: 4,
      passengers: riders.map((r) => ({ riderId: r.id, status: "PICKED_UP" as const, lockedFare: 500 })),
    });
    rideIds.push(car.id);
    const res = await app.inject({ method: "GET", url: `/rides/${car.id}/fill-suggestions`, headers: b.auth });
    expect(res.json().suggestions).toEqual([]);
  });
});

describe("withdrawn offers reach drivers at once", () => {
  it("taken, cancelled and expired requests send ride:offer_closed to the drivers they were offered to", async () => {
    const closed: Array<{ ids: string[]; payload: { rideId: string; reason: string } }> = [];
    vi.spyOn(rideSocket, "emitOfferClosed").mockImplementation((ids, payload) => void closed.push({ ids, payload }));

    const taken = await request();
    const a = await driver(taken.ride.pickupZoneId);
    const b = await driver(taken.ride.pickupZoneId);
    await app.inject({ method: "POST", url: `/rides/${taken.ride.id}/claim`, headers: a.auth });
    await vi.waitFor(() => expect(closed.find((c) => c.payload.rideId === taken.ride.id)).toBeDefined());
    const takenEvent = closed.find((c) => c.payload.rideId === taken.ride.id)!;
    expect(takenEvent.payload.reason).toBe("TAKEN");
    expect(takenEvent.ids).toContain(b.id);

    const cancelled = await request();
    const riderAuth = { authorization: `Bearer ${signAccessToken({ userId: cancelled.ride.riderId, role: "RIDER" })}` };
    await app.inject({ method: "POST", url: `/rides/${cancelled.ride.id}/cancel`, headers: riderAuth, payload: {} });
    await vi.waitFor(() => expect(closed.find((c) => c.payload.rideId === cancelled.ride.id)?.payload.reason).toBe("CANCELLED"));

    const expired = await request();
    await prisma.ride.update({ where: { id: expired.ride.id }, data: { broadcastStartedAt: new Date(Date.now() - DISPATCH_WINDOW_MS - 1000) } });
    await processTimeouts(prisma, new Date(), { rideIds: [expired.ride.id], logger: { info: () => {}, warn: () => {} } });
    await vi.waitFor(() => expect(closed.find((c) => c.payload.rideId === expired.ride.id)?.payload.reason).toBe("EXPIRED"));
  });
});

describe("a request made before a price change", () => {
  it("is offered at the fare its rider was quoted, in the list and in the broadcast", async () => {
    const { ride } = await request("SHARED"); // its seat is locked at the old GH₵5
    const a = await driver(ride.pickupZoneId);

    const listed = (await eligible(a.auth)).find((r) => r.rideId === ride.id);
    expect(listed).toMatchObject({ farePesewas: 500, driverSharePesewas: splitFare(500).driverShare });

    const sent: Array<{ rideId: string; farePesewas: number; driverSharePesewas: number }> = [];
    vi.spyOn(rideSocket, "emitDriverBroadcast").mockImplementation((_ids, p) => void sent.push(p));
    await broadcastRide(prisma, ride.id);
    expect(sent.find((p) => p.rideId === ride.id)).toMatchObject({ farePesewas: 500, driverSharePesewas: 425 });
  });

  it("a request quoted at today's fare is offered at today's", async () => {
    const { ride } = await request("SHARED");
    await prisma.ridePassenger.updateMany({ where: { rideId: ride.id }, data: { lockedFare: getSharedFarePerRider(1) } });
    const a = await driver(ride.pickupZoneId);
    const listed = (await eligible(a.auth)).find((r) => r.rideId === ride.id);
    expect(listed).toMatchObject({ farePesewas: 700, driverSharePesewas: 595 });
  });
});

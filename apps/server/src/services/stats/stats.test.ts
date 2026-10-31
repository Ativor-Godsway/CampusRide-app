/**
 * Records for the admin dashboard (services/stats). Pins:
 *   1. online sessions open and close with the switch, end on admin
 *      rejection, and time out when the app goes quiet — at the last moment
 *      it was heard — then reopen if it comes back while still online;
 *   2. the location trail keeps one point per 30 s per driver, writes in one
 *      batch, and deletes points past 90 days;
 *   3. every offer's outcome: accepted, declined, timed out, taken, cancelled, expired;
 *   4. a ride's matched / cancelled / no-driver-found times.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { prisma } from "../../db/prisma";
import { registerDriverRoutes } from "../../routes/driver";
import { signAccessToken } from "../auth/tokens";
import { cleanupRide, createTestDriver, createTestRide } from "../ride/testFixtures";
import { applyRideTransition } from "../ride/rideService";
import { closeDriverSession, openDriverSession, SESSION_TIMEOUT_MS, timeOutQuietSessions } from "./driverSessions";
import {
  LOCATION_TRAIL_KEEP_DAYS,
  SAMPLE_MS,
  flushLocationTrail,
  noteDriverPosition,
  purgeOldLocationPoints,
  resetLocationTrailForTests,
} from "./locationTrail";
import { recordOfferAnswer, recordOffers, recordOffersClosed } from "./rideOffers";

let app: FastifyInstance;
const driverIds: string[] = [];
const rideIds: string[] = [];
const MIN = 60_000;
const BALME = { latitude: 5.65201, longitude: -0.18705 };

beforeAll(async () => {
  app = Fastify();
  registerDriverRoutes(app, prisma);
  await app.ready();
});
beforeEach(() => resetLocationTrailForTests());
afterEach(async () => {
  while (rideIds.length) await cleanupRide(rideIds.pop()!);
  const ids = driverIds.splice(0);
  await prisma.driver.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

async function driver(isOnline = false) {
  const { user } = await createTestDriver({ isOnline, isApproved: true });
  driverIds.push(user.id);
  return { user, headers: { authorization: `Bearer ${signAccessToken({ userId: user.id, role: "DRIVER" })}` } };
}
const sessions = (driverUserId: string) =>
  prisma.driverOnlineSession.findMany({ where: { driverUserId }, orderBy: { startedAt: "asc" } });
const goOnline = (headers: Record<string, string>, isOnline: boolean) =>
  app.inject({ method: "PATCH", url: "/driver/availability", headers, payload: { isOnline } });

describe("driver online sessions", () => {
  it("open on going online (once), close OFFLINE on going offline", async () => {
    const d = await driver();
    expect((await goOnline(d.headers, true)).statusCode).toBe(200);
    expect((await goOnline(d.headers, true)).statusCode).toBe(200);
    expect(await sessions(d.user.id)).toHaveLength(1);
    expect((await goOnline(d.headers, false)).statusCode).toBe(200);
    const [s] = await sessions(d.user.id);
    expect(s).toMatchObject({ endReason: "OFFLINE" });
    expect(s!.endedAt!.getTime()).toBeGreaterThanOrEqual(s!.startedAt.getTime());
  });

  it("time out at the last moment the app was heard, and reopen if it is heard again while online", async () => {
    const d = await driver(true);
    const t0 = Date.now();
    await openDriverSession(prisma, d.user.id, new Date(t0 - 20 * MIN));
    noteDriverPosition(d.user.id, BALME, false, t0 - 10 * MIN);
    await flushLocationTrail(prisma);
    const lastSeen = (await sessions(d.user.id))[0]!.lastSeenAt!;
    expect(lastSeen.getTime()).toBe(t0 - 10 * MIN);

    // Inside the grace after a server start, nothing is timed out.
    expect(await timeOutQuietSessions(prisma, new Date(t0), t0 - MIN)).toBe(0);
    expect(await timeOutQuietSessions(prisma, new Date(t0), 0)).toBeGreaterThanOrEqual(1);
    const [ended] = await sessions(d.user.id);
    expect(ended).toMatchObject({ endReason: "TIMEOUT" });
    expect(ended!.endedAt!.getTime()).toBe(lastSeen.getTime());

    // Heard again, still online: a new session.
    noteDriverPosition(d.user.id, BALME, false, t0);
    await flushLocationTrail(prisma);
    const all = await sessions(d.user.id);
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({ endedAt: null, startedAt: new Date(t0) });
  });

  it("a session never heard from (an app that sends no idle position) is never timed out", async () => {
    const d = await driver(true);
    await openDriverSession(prisma, d.user.id, new Date(Date.now() - 60 * MIN));
    await timeOutQuietSessions(prisma, new Date(Date.now() + SESSION_TIMEOUT_MS), 0);
    expect((await sessions(d.user.id))[0]).toMatchObject({ endedAt: null });
  });

  it("an admin taking approval away ends it with ADMIN", async () => {
    const d = await driver(true);
    await openDriverSession(prisma, d.user.id);
    await closeDriverSession(prisma, d.user.id, "ADMIN");
    expect((await sessions(d.user.id))[0]).toMatchObject({ endReason: "ADMIN" });
  });
});

describe("the location trail", () => {
  it("keeps one point per 30 s per driver, written in one batch with on-trip marked", async () => {
    const [a, b] = [await driver(true), await driver(true)];
    const t0 = Date.now();
    for (let s = 0; s < 70; s += 5) noteDriverPosition(a.user.id, BALME, false, t0 + s * 1000);
    noteDriverPosition(b.user.id, BALME, true, t0);
    expect(await prisma.driverLocationPoint.count({ where: { driverUserId: a.user.id } })).toBe(0);
    expect(await flushLocationTrail(prisma)).toBe(3 + 1);
    const pointsA = await prisma.driverLocationPoint.findMany({ where: { driverUserId: a.user.id }, orderBy: { recordedAt: "asc" } });
    expect(pointsA.map((p) => p.recordedAt.getTime() - t0)).toEqual([0, SAMPLE_MS, 2 * SAMPLE_MS]);
    expect(pointsA[0]!.latitude).toBeCloseTo(BALME.latitude, 4);
    expect(await prisma.driverLocationPoint.findFirst({ where: { driverUserId: b.user.id } })).toMatchObject({ onTrip: true });
  });

  it("deletes points older than 90 days, and only those", async () => {
    const d = await driver(true);
    const day = 24 * 60 * MIN;
    await prisma.driverLocationPoint.createMany({
      data: [LOCATION_TRAIL_KEEP_DAYS + 1, LOCATION_TRAIL_KEEP_DAYS - 1, 0].map((ago) => ({
        driverUserId: d.user.id,
        latitude: BALME.latitude,
        longitude: BALME.longitude,
        recordedAt: new Date(Date.now() - ago * day),
      })),
    });
    expect(await purgeOldLocationPoints(prisma)).toBeGreaterThanOrEqual(1);
    expect(await prisma.driverLocationPoint.count({ where: { driverUserId: d.user.id } })).toBe(2);
  });
});

describe("ride offers", () => {
  it("records each driver's outcome and how long it took", async () => {
    const [taker, decliner, sleeper, other] = [await driver(true), await driver(true), await driver(true), await driver(true)];
    const { ride } = await createTestRide({ type: "LONE", status: "REQUESTED" });
    rideIds.push(ride.id);
    const t0 = new Date(Date.now() - 20_000);
    const ids = [taker, decliner, sleeper, other].map((d) => d.user.id);
    await recordOffers(prisma, ride.id, ids, t0);
    // A re-broadcast keeps the first time.
    await recordOffers(prisma, ride.id, ids, new Date());
    await recordOfferAnswer(prisma, ride.id, decliner.user.id, "DECLINED", new Date(t0.getTime() + 4_000));
    await recordOfferAnswer(prisma, ride.id, sleeper.user.id, "TIMED_OUT", new Date(t0.getTime() + 15_000));
    await recordOffersClosed(prisma, ride.id, "TAKEN", taker.user.id, new Date(t0.getTime() + 9_000));
    // A late answer changes nothing: the first stands.
    await recordOfferAnswer(prisma, ride.id, other.user.id, "DECLINED");

    const rows = await prisma.rideOffer.findMany({ where: { rideId: ride.id } });
    const by = (d: { user: { id: string } }) => rows.find((r) => r.driverUserId === d.user.id)!;
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.offeredAt.getTime() === t0.getTime())).toBe(true);
    expect(by(taker)).toMatchObject({ outcome: "ACCEPTED" });
    expect(by(taker).decidedAt!.getTime() - t0.getTime()).toBe(9_000);
    expect(by(decliner)).toMatchObject({ outcome: "DECLINED" });
    expect(by(sleeper)).toMatchObject({ outcome: "TIMED_OUT" });
    expect(by(other)).toMatchObject({ outcome: "TAKEN" });
  });

  it("cancelled and expired close every open offer", async () => {
    const d = await driver(true);
    for (const reason of ["CANCELLED", "EXPIRED"] as const) {
      const { ride } = await createTestRide({ type: "LONE", status: "REQUESTED" });
      rideIds.push(ride.id);
      await recordOffers(prisma, ride.id, [d.user.id]);
      await recordOffersClosed(prisma, ride.id, reason, null);
      expect(await prisma.rideOffer.findFirst({ where: { rideId: ride.id } })).toMatchObject({ outcome: reason });
    }
  });
});

describe("ride request times", () => {
  it("stamps no driver found (first time only), matched and cancelled", async () => {
    const d = await driver(true);
    const { ride } = await createTestRide({ type: "LONE", status: "REQUESTED" });
    rideIds.push(ride.id);
    const t1 = new Date(Date.now() - 60_000);
    await applyRideTransition(prisma, ride.id, "AWAITING_RIDER_DECISION", {}, t1);
    await applyRideTransition(prisma, ride.id, "REQUESTED", {}, new Date(t1.getTime() + 5_000));
    await applyRideTransition(prisma, ride.id, "AWAITING_RIDER_DECISION", {}, new Date(t1.getTime() + 100_000));
    expect((await prisma.ride.findUniqueOrThrow({ where: { id: ride.id } })).noDriverFoundAt).toEqual(t1);

    await prisma.$executeRaw`UPDATE "Ride" SET status = 'REQUESTED' WHERE id = ${ride.id}`;
    const { claimIfOpen } = await import("../ride/dispatch");
    await claimIfOpen(prisma, ride.id, d.user.id);
    expect((await prisma.ride.findUniqueOrThrow({ where: { id: ride.id } })).matchedAt).not.toBeNull();

    const other = await createTestRide({ type: "LONE", status: "REQUESTED" });
    rideIds.push(other.ride.id);
    const t2 = new Date();
    await applyRideTransition(prisma, other.ride.id, "CANCELLED", { cancelReason: "RIDER_CANCELLED" }, t2);
    expect(await prisma.ride.findUniqueOrThrow({ where: { id: other.ride.id } })).toMatchObject({ cancelledAt: t2, cancelReason: "RIDER_CANCELLED" });
  });
});

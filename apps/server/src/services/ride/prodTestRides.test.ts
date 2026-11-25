/**
 * Production test rides (2026-11-25, `npm run prodtest:requests`): fake
 * riders flagged review-demo request rides, and exactly one real driver is
 * flagged review-demo for the test. Pins:
 *   1. their requests are offered to that driver only — never to a real
 *      driver, by pop-up, board or list — and never to the simulated driver;
 *   2. the flagged driver's board shows them while CampusRide is closed, and
 *      riders stay refused (CampusRide isn't opened);
 *   3. no commission is owed on them; their refusals aren't logged.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { prisma } from "../../db/prisma";
import { registerDriverRoutes } from "../../routes/driver";
import { signAccessToken } from "../auth/tokens";
import { createRide } from "./createRide";
import { driversOfferedTo } from "./dispatch";
import { finalizeRideCompletion } from "./completion";
import { recordRefusedBooking } from "./refusedBookings";
import { isServedBySimDriver } from "../reviewDemo/simulation";
import { createTestDriver, getThreeTestZones } from "./testFixtures";
import { assertServiceOpen, clearServiceHoursCache, setServiceHoursGateForTests } from "../service/serviceHours";

let app: FastifyInstance;
const userIds: string[] = [];
let seq = 0;

beforeAll(async () => {
  app = Fastify();
  registerDriverRoutes(app, prisma);
  await app.ready();
});

afterEach(async () => {
  setServiceHoursGateForTests(false);
  await prisma.serviceHoursSetting.deleteMany({});
  clearServiceHoursCache();
  const ids = userIds.splice(0);
  await prisma.commissionLedger.deleteMany({ where: { driverUserId: { in: ids } } });
  await prisma.ride.deleteMany({ where: { OR: [{ riderId: { in: ids } }, { driverId: { in: ids } }] } });
  await prisma.refusedBooking.deleteMany({});
  await prisma.driver.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
});

afterAll(async () => {
  await app.close();
});

/** A fake test rider, as prodtest:requests makes them. */
async function testRider() {
  seq += 1;
  const user = await prisma.user.create({
    data: { phone: `+233099${String(800_000 + seq).padStart(6, "0")}`, name: `Test ${seq} (test)`, role: "RIDER", isReviewDemo: true },
  });
  userIds.push(user.id);
  return user;
}

async function driver(opts: { demo?: boolean; zoneId: string }) {
  const { user } = await createTestDriver({ isOnline: true, currentZoneId: opts.zoneId });
  userIds.push(user.id);
  if (opts.demo) await prisma.user.update({ where: { id: user.id }, data: { isReviewDemo: true } });
  return { id: user.id, headers: { authorization: `Bearer ${signAccessToken({ userId: user.id, role: "DRIVER" })}` } };
}

async function testRequest(pickupZoneId: string, dropoffZoneId: string) {
  const rider = await testRider();
  const ride = await createRide(prisma, { riderId: rider.id, type: "SHARED", pickupZoneId, dropoffZoneId, paymentMethod: "CASH" });
  return prisma.ride.findUniqueOrThrow({ where: { id: ride.id }, include: { passengers: { select: { riderId: true, status: true, lockedFare: true } } } });
}

describe("production test rides", () => {
  it("are offered to the flagged driver only — never a real driver, never the simulated driver", async () => {
    const { pickup, adjacent, distant } = await getThreeTestZones();
    const me = await driver({ demo: true, zoneId: distant.id });
    const realNearby = await driver({ zoneId: pickup.id });
    const request = await testRequest(pickup.id, adjacent.id);
    expect(request.isReviewDemo).toBe(true);
    expect(await isServedBySimDriver(prisma, request)).toBe(false);
    const offered = await driversOfferedTo(prisma, request);
    expect(offered).toContain(me.id);
    expect(offered).not.toContain(realNearby.id);

    const board = async (d: { headers: Record<string, string> }) =>
      ((await app.inject({ method: "GET", url: "/driver/requests/board", headers: d.headers })).json() as { rides: Array<{ rideId: string }> }).rides.map((r) => r.rideId);
    expect(await board(me)).toContain(request.id);
    expect(await board(realNearby)).not.toContain(request.id);
    const list = async (d: { headers: Record<string, string> }) =>
      ((await app.inject({ method: "GET", url: "/driver/rides/eligible", headers: d.headers })).json() as { rides: Array<{ rideId: string }> }).rides.map((r) => r.rideId);
    expect(await list(me)).toContain(request.id);
    expect(await list(realNearby)).not.toContain(request.id);
    const stolen = await app.inject({ method: "POST", url: `/rides/${request.id}/claim`, headers: realNearby.headers, payload: {} });
    expect(stolen.statusCode).toBe(409);
  });

  it("show on the flagged driver's board while CampusRide is closed, which stays closed for real riders", async () => {
    const { pickup, adjacent } = await getThreeTestZones();
    setServiceHoursGateForTests(true);
    await prisma.serviceHoursSetting.create({ data: { id: "service", weekly: Array.from({ length: 7 }, () => null), blockWhenNoDrivers: false } });
    clearServiceHoursCache();
    const me = await driver({ demo: true, zoneId: pickup.id });
    const real = await driver({ zoneId: pickup.id });
    const request = await testRequest(pickup.id, adjacent.id);

    const myBoard = (await app.inject({ method: "GET", url: "/driver/requests/board", headers: me.headers })).json();
    expect(myBoard.open).toBe(true);
    expect(myBoard.rides.map((r: { rideId: string }) => r.rideId)).toContain(request.id);
    expect((await app.inject({ method: "GET", url: "/driver/requests/board", headers: real.headers })).json()).toMatchObject({ open: false, rides: [] });

    const realRider = await prisma.user.create({ data: { phone: "+233200000777", name: "Real rider", role: "RIDER" } });
    userIds.push(realRider.id);
    await expect(assertServiceOpen(prisma, realRider.id)).rejects.toThrow();
  });

  it("owe no commission when completed, and their refusals aren't logged", async () => {
    const { pickup, adjacent } = await getThreeTestZones();
    const me = await driver({ demo: true, zoneId: pickup.id });
    const request = await testRequest(pickup.id, adjacent.id);
    await finalizeRideCompletion(prisma, { ...request, type: "SHARED" }, me.id, [{ riderId: request.riderId, status: "DROPPED_OFF", lockedFare: 700 }]);
    expect(await prisma.commissionLedger.count({ where: { driverUserId: me.id } })).toBe(0);

    await recordRefusedBooking(prisma, { riderId: request.riderId, reason: "ACTIVE_RIDE_EXISTS", stage: "REQUEST" });
    expect(await prisma.refusedBooking.count()).toBe(0);
  });
});

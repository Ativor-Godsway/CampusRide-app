/**
 * Dispatch fallback (2026-11-24). Pins:
 *   1. with a live free driver in the pickup zone or a neighbour, only the
 *      nearby drivers get the request (a driver across campus doesn't);
 *   2. with none there (nobody, only stale drivers, only busy ones, or the
 *      nearby ones declined), every live free driver on campus gets it —
 *      never a stale one, never one who declined;
 *   3. a driver across campus sees such a request in their own list
 *      ("Requests near you"), and not a request someone near it can take.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Zone } from "@prisma/client";
import { DRIVER_STALE_AFTER_MS } from "@rida/shared";
import { prisma } from "../../db/prisma";
import { driversOfferedTo } from "./dispatch";
import { requestsForFreeDriver } from "./requestFit";
import { cleanupRide, createTestDriver, createTestRide, createZoneAdjacency } from "./testFixtures";

const MARK = `dispatch-fallback-${Date.now()}`;
let zones: { a: Zone; b: Zone; c: Zone };
const userIds: string[] = [];
const rideIds: string[] = [];
let rowsBefore: string[] = [];
let onlineBefore: string[] = [];

beforeEach(async () => {
  // Only this file's drivers are online (rows other files left behind are set aside).
  onlineBefore = (await prisma.driver.findMany({ where: { isOnline: true }, select: { userId: true } })).map((d) => d.userId);
  await prisma.driver.updateMany({ where: { userId: { in: onlineBefore } }, data: { isOnline: false } });
  rowsBefore = (await prisma.zoneAdjacency.findMany({ select: { id: true } })).map((r) => r.id);
  const zone = (name: string, latitude: number) =>
    prisma.zone.create({ data: { name: `${MARK} ${name}`, quadrant: "CENTRAL", latitude, longitude: -0.187 } });
  zones = { a: await zone("A", 5.65), b: await zone("B", 5.6505), c: await zone("C", 5.63) };
  await createZoneAdjacency(zones.a.id, zones.b.id);
});

afterEach(async () => {
  while (rideIds.length) await cleanupRide(rideIds.pop()!);
  const ids = userIds.splice(0);
  await prisma.ride.deleteMany({ where: { driverId: { in: ids } } });
  await prisma.driver.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.zoneAdjacency.deleteMany({ where: { id: { notIn: rowsBefore } } });
  await prisma.zone.deleteMany({ where: { name: { startsWith: MARK } } });
  await prisma.driver.updateMany({ where: { userId: { in: onlineBefore } }, data: { isOnline: true } });
});

async function driverIn(zone: Zone, opts: { stale?: boolean } = {}) {
  const { user } = await createTestDriver({
    isOnline: true,
    currentZoneId: zone.id,
    lastHeartbeatAt: new Date(Date.now() - (opts.stale ? DRIVER_STALE_AFTER_MS + 60_000 : 0)),
  });
  userIds.push(user.id);
  return user.id;
}

async function requestIn(zone: Zone) {
  const { ride } = await createTestRide({ type: "LONE", pickupZoneId: zone.id, dropoffZoneId: zones.c.id, broadcastStartedAt: new Date() });
  rideIds.push(ride.id);
  return prisma.ride.findUniqueOrThrow({ where: { id: ride.id }, include: { passengers: { select: { riderId: true, status: true, lockedFare: true } } } });
}

describe("dispatch fallback", () => {
  it("a live free driver nearby: only nearby drivers get it", async () => {
    const near = await driverIn(zones.b);
    const far = await driverIn(zones.c);
    const offered = await driversOfferedTo(prisma, await requestIn(zones.a));
    expect(offered).toContain(near);
    expect(offered).not.toContain(far);
  });

  it("nobody live nearby (only a stale driver): every live driver on campus gets it, never the stale one", async () => {
    const stale = await driverIn(zones.b, { stale: true });
    const far = await driverIn(zones.c);
    const offered = await driversOfferedTo(prisma, await requestIn(zones.a));
    expect(offered).toContain(far);
    expect(offered).not.toContain(stale);
  });

  it("the only nearby driver is busy on a trip: it widens", async () => {
    const busy = await driverIn(zones.a);
    const { ride } = await createTestRide({ type: "LONE", status: "IN_PROGRESS", driverId: busy });
    rideIds.push(ride.id);
    const far = await driverIn(zones.c);
    const offered = await driversOfferedTo(prisma, await requestIn(zones.a));
    expect(offered).toEqual([far]);
  });

  it("the nearby driver declined: it widens, and never back to the one who declined", async () => {
    const near = await driverIn(zones.b);
    const far = await driverIn(zones.c);
    const request = await requestIn(zones.a);
    await prisma.rideRejection.create({ data: { rideId: request.id, driverUserId: near, reason: "DECLINED" } });
    const offered = await driversOfferedTo(prisma, request);
    expect(offered).toContain(far);
    expect(offered).not.toContain(near);
  });

  it("a driver across campus lists a request nobody near it can take, and not one somebody can", async () => {
    const far = await driverIn(zones.c);
    const stranded = await requestIn(zones.a);
    const listed = async () => (await requestsForFreeDriver(prisma, { userId: far, currentZoneId: zones.c.id, isReviewDemo: false })).map((r) => r.id);
    expect(await listed()).toContain(stranded.id);
    await driverIn(zones.b);
    expect(await listed()).not.toContain(stranded.id);
  });
});

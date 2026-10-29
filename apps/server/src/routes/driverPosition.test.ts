import { describe, it, expect, afterEach, afterAll, beforeAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { DRIVER_OUTSIDE_AREA_MESSAGE, nearestZone } from "@rida/shared";
import { prisma } from "../db/prisma";
import { registerDriverRoutes } from "./driver";
import { signAccessToken } from "../services/auth/tokens";
import {
  cleanupDriver,
  cleanupRide,
  createTestDriver,
  createTestRide,
  getTestZones,
} from "../services/ride/testFixtures";

/**
 * The server's own check of the driver's position (campus-only CampusRide):
 * apps from 2026-10-29 send latitude/longitude with going online and with
 * zone updates; older apps send none and keep the old behaviour.
 */
let app: FastifyInstance;
const createdDriverUserIds: string[] = [];
const createdRideIds: string[] = [];

const BALME = { latitude: 5.65201, longitude: -0.18705 };
/** Legon City Mall, east of J.J. Rawlings Avenue: not served. */
const OFF_CAMPUS = { latitude: 5.653443, longitude: -0.178819 };

beforeAll(async () => {
  app = Fastify();
  registerDriverRoutes(app, prisma);
  await app.ready();
});

afterEach(async () => {
  while (createdRideIds.length > 0) await cleanupRide(createdRideIds.pop()!);
  while (createdDriverUserIds.length > 0) await cleanupDriver(createdDriverUserIds.pop()!);
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

async function driverWith(opts: { isOnline: boolean; currentZoneId?: string | null; reviewDemo?: boolean }) {
  const { user } = await createTestDriver({ isApproved: true, isOnline: opts.isOnline, currentZoneId: opts.currentZoneId });
  createdDriverUserIds.push(user.id);
  if (opts.reviewDemo) await prisma.user.update({ where: { id: user.id }, data: { isReviewDemo: true } });
  return { user, token: signAccessToken({ userId: user.id, role: "DRIVER" }) };
}

const patch = (url: string, token: string, body: Record<string, unknown>) =>
  app.inject({ method: "PATCH", url, headers: { authorization: `Bearer ${token}` }, payload: body });

async function zoneNearest(point: { latitude: number; longitude: number }) {
  const zones = await prisma.zone.findMany({ where: { retiredAt: null } });
  return nearestZone(point.latitude, point.longitude, zones)!.id;
}

const driverRow = (userId: string) => prisma.driver.findUniqueOrThrow({ where: { userId } });

describe("PATCH /driver/availability with a position", () => {
  it("on campus: online, in the zone the SERVER works out, position kept", async () => {
    const { dropoff } = await getTestZones();
    const { user, token } = await driverWith({ isOnline: false });

    // The app's zone is ignored when it sends a position.
    const res = await patch("/driver/availability", token, { isOnline: true, zoneId: dropoff.id, ...BALME });

    expect(res.statusCode).toBe(200);
    const driver = await driverRow(user.id);
    expect(driver).toMatchObject({ isOnline: true, currentZoneId: await zoneNearest(BALME), lastLat: BALME.latitude, lastLng: BALME.longitude });
    expect(driver.lastSeenAt).toBeInstanceOf(Date);
  });

  it("off campus: refused, stays offline, position not kept", async () => {
    const { user, token } = await driverWith({ isOnline: false });

    const res = await patch("/driver/availability", token, { isOnline: true, ...OFF_CAMPUS });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ code: "OUTSIDE_SERVICE_AREA", error: DRIVER_OUTSIDE_AREA_MESSAGE });
    expect(await driverRow(user.id)).toMatchObject({ isOnline: false, currentZoneId: null, lastLat: null, lastSeenAt: null });
  });

  it("off campus on a trip: the trip keeps working (online, but no zone, so no new requests)", async () => {
    const { pickup, dropoff } = await getTestZones();
    const { user, token } = await driverWith({ isOnline: false });
    const { ride } = await createTestRide({ type: "LONE", status: "IN_PROGRESS", driverId: user.id, pickupZoneId: pickup.id, dropoffZoneId: dropoff.id });
    createdRideIds.push(ride.id);

    const res = await patch("/driver/availability", token, { isOnline: true, zoneId: pickup.id, ...OFF_CAMPUS });

    expect(res.statusCode).toBe(200);
    expect(await driverRow(user.id)).toMatchObject({ isOnline: true, currentZoneId: null, lastLat: OFF_CAMPUS.latitude });
  });

  it("needs both latitude and longitude", async () => {
    const { token } = await driverWith({ isOnline: false });
    expect((await patch("/driver/availability", token, { isOnline: true, latitude: 5.652 })).statusCode).toBe(400);
  });

  it("an older app (no position) still goes online in the zone it sends", async () => {
    const { pickup } = await getTestZones();
    const { user, token } = await driverWith({ isOnline: false });

    const res = await patch("/driver/availability", token, { isOnline: true, zoneId: pickup.id });

    expect(res.statusCode).toBe(200);
    expect(await driverRow(user.id)).toMatchObject({ isOnline: true, currentZoneId: pickup.id, lastLat: null });
  });

  it("a review demo driver is exempt: online anywhere, with the zone the app sends", async () => {
    const { pickup } = await getTestZones();
    const { user, token } = await driverWith({ isOnline: false, reviewDemo: true });

    const res = await patch("/driver/availability", token, { isOnline: true, zoneId: pickup.id, ...OFF_CAMPUS });

    expect(res.statusCode).toBe(200);
    expect(await driverRow(user.id)).toMatchObject({ isOnline: true, currentZoneId: pickup.id, lastLat: null });
  });
});

describe("PATCH /driver/zone with a position", () => {
  it("on campus: the server's zone, position kept", async () => {
    const { dropoff } = await getTestZones();
    const { user, token } = await driverWith({ isOnline: true, currentZoneId: dropoff.id });

    const res = await patch("/driver/zone", token, { zoneId: dropoff.id, ...BALME });

    expect(res.statusCode).toBe(200);
    const zoneId = await zoneNearest(BALME);
    expect(res.json()).toEqual({ zoneId });
    expect(await driverRow(user.id)).toMatchObject({ currentZoneId: zoneId, lastLat: BALME.latitude, lastLng: BALME.longitude });
  });

  it("off campus: the zone is cleared (no new requests), even if the app sends one", async () => {
    const { pickup } = await getTestZones();
    const { user, token } = await driverWith({ isOnline: true, currentZoneId: pickup.id });

    const res = await patch("/driver/zone", token, { zoneId: pickup.id, ...OFF_CAMPUS });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ zoneId: null });
    expect(await driverRow(user.id)).toMatchObject({ isOnline: true, currentZoneId: null, lastLat: OFF_CAMPUS.latitude });
  });

  it("an older app (no position) still sets the zone it sends", async () => {
    const { pickup, dropoff } = await getTestZones();
    const { user, token } = await driverWith({ isOnline: true, currentZoneId: dropoff.id });

    expect((await patch("/driver/zone", token, { zoneId: pickup.id })).json()).toEqual({ zoneId: pickup.id });
    expect((await driverRow(user.id)).currentZoneId).toBe(pickup.id);
  });

  it("a review demo driver keeps the zone the app sends", async () => {
    const { pickup, dropoff } = await getTestZones();
    const { user, token } = await driverWith({ isOnline: true, currentZoneId: dropoff.id, reviewDemo: true });

    expect((await patch("/driver/zone", token, { zoneId: pickup.id, ...OFF_CAMPUS })).json()).toEqual({ zoneId: pickup.id });
    expect((await driverRow(user.id)).lastLat).toBeNull();
  });
});

describe("GET /driver/rides/eligible with an off-campus position", () => {
  it("offers nothing, even with a zone still set", async () => {
    const { pickup, dropoff } = await getTestZones();
    const { token } = await driverWith({ isOnline: true, currentZoneId: pickup.id });
    const { ride } = await createTestRide({
      type: "LONE",
      status: "REQUESTED",
      pickupZoneId: pickup.id,
      dropoffZoneId: dropoff.id,
      broadcastStartedAt: new Date(),
    });
    createdRideIds.push(ride.id);
    const eligible = (query: string) =>
      app.inject({ method: "GET", url: `/driver/rides/eligible${query}`, headers: { authorization: `Bearer ${token}` } });

    const onCampus = await eligible(`?lat=${BALME.latitude}&lng=${BALME.longitude}`);
    expect(onCampus.json().rides.some((r: { rideId: string }) => r.rideId === ride.id)).toBe(true);
    const offCampus = await eligible(`?lat=${OFF_CAMPUS.latitude}&lng=${OFF_CAMPUS.longitude}`);
    expect(offCampus.json().rides).toEqual([]);
  });
});

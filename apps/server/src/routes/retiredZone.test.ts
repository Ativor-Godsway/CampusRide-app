/**
 * A retired zone (Zone.retiredAt, e.g. "Accra Mall Junction") stays for old
 * rides but is used for nothing new: not offered by GET /zones, never
 * derived from a pin, refused when an old app books it by id, never a
 * driver's zone, and never a path for driver eligibility.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { Zone } from "@prisma/client";
import { nearestZone } from "@rida/shared";
import { prisma } from "../db/prisma";
import { registerRideRoutes } from "./rides";
import { registerDriverRoutes } from "./driver";
import { registerZoneRoutes } from "./zones";
import { signAccessToken } from "../services/auth/tokens";
import { cleanupDriver, createTestDriver, createTestUser } from "../services/ride/testFixtures";
import { getEligibleDrivers } from "../services/ride/dispatch";
import { getZoneAdjacency } from "../services/zones/zoneCache";

vi.mock("../services/sms/sendSms", () => ({ sendSms: vi.fn().mockResolvedValue({ success: true }) }));

let app: FastifyInstance;
let retired: Zone;
let active: Zone[];
const userIds: string[] = [];
const driverIds: string[] = [];
// Great Hall's real position: well away from the seeded zone centres.
const SPOT = { latitude: 5.650634, longitude: -0.196217 };

beforeAll(async () => {
  app = Fastify();
  registerRideRoutes(app, prisma);
  registerDriverRoutes(app, prisma);
  registerZoneRoutes(app, prisma);
  await app.ready();
  active = await prisma.zone.findMany({ where: { retiredAt: null } });
  retired = await prisma.zone.create({
    data: { name: `Retired test zone ${Date.now()}`, quadrant: "WEST", ...SPOT, retiredAt: new Date() },
  });
});

afterEach(async () => {
  await prisma.ridePassenger.deleteMany({ where: { riderId: { in: userIds } } });
  await prisma.ride.deleteMany({ where: { riderId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  userIds.length = 0;
  while (driverIds.length) await cleanupDriver(driverIds.pop()!);
});

afterAll(async () => {
  await prisma.zoneAdjacency.deleteMany({ where: { OR: [{ zoneId: retired.id }, { adjacentZoneId: retired.id }] } });
  await prisma.zone.delete({ where: { id: retired.id } });
  await app.close();
});

async function rider() {
  const user = await createTestUser("RIDER");
  userIds.push(user.id);
  return signAccessToken({ userId: user.id, role: "RIDER" });
}

describe("a retired zone", () => {
  it("is not offered by GET /zones", async () => {
    const res = await app.inject({ method: "GET", url: "/zones", headers: { authorization: `Bearer ${await rider()}` } });
    const ids = res.json().zones.map((z: { id: string }) => z.id);
    expect(ids).not.toContain(retired.id);
    expect(ids).toHaveLength(active.length);
  });

  it("is never derived from a pin, even one at its very centre", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/rides",
      headers: { authorization: `Bearer ${await rider()}` },
      payload: { type: "LONE", pickup: SPOT, dropoff: { latitude: 5.64208, longitude: -0.1856 } },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().ride.pickupZoneId).toBe(nearestZone(SPOT.latitude, SPOT.longitude, active)!.id);
  });

  it("is refused when an old app books it by id", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/rides",
      headers: { authorization: `Bearer ${await rider()}` },
      payload: { type: "LONE", pickupZoneId: retired.id, dropoffZoneId: active[0]!.id },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "ZONE_NOT_SERVED" });
  });

  it("is never a driver's zone: an app sending it is counted in the nearest zone in service", async () => {
    const { user } = await createTestDriver({ isOnline: false, isApproved: true });
    driverIds.push(user.id);
    const auth = { authorization: `Bearer ${signAccessToken({ userId: user.id, role: "DRIVER" })}` };
    const served = nearestZone(retired.latitude, retired.longitude, active)!.id;

    const online = await app.inject({ method: "PATCH", url: "/driver/availability", headers: auth, payload: { isOnline: true, zoneId: retired.id } });
    expect(online.statusCode).toBe(200);
    expect(online.json().driver.currentZoneId).toBe(served);

    const moved = await app.inject({ method: "PATCH", url: "/driver/zone", headers: auth, payload: { zoneId: retired.id } });
    expect(moved.json()).toEqual({ zoneId: served });
  });

  it("is never a path for eligibility", async () => {
    const neighbour = active[0]!;
    await prisma.zoneAdjacency.create({ data: { zoneId: retired.id, adjacentZoneId: neighbour.id } });
    // A driver left in the retired zone (from before it was retired).
    const { user } = await createTestDriver({ isOnline: true, isApproved: true, currentZoneId: retired.id });
    driverIds.push(user.id);

    const eligible = await getEligibleDrivers(prisma, { pickupZoneId: neighbour.id });
    expect(eligible.map((d) => d.userId)).not.toContain(user.id);
    const edges = await getZoneAdjacency(prisma);
    expect(edges.some((e) => e.zoneId === retired.id || e.adjacentZoneId === retired.id)).toBe(false);
  });
});

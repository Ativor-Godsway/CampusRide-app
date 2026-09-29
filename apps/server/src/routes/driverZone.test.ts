import { describe, it, expect, afterEach, afterAll, beforeAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
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

let app: FastifyInstance;
const createdDriverUserIds: string[] = [];
const createdRideIds: string[] = [];

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

async function driverWith(opts: { isOnline: boolean; currentZoneId?: string | null }) {
  const { user } = await createTestDriver({ isApproved: true, ...opts });
  createdDriverUserIds.push(user.id);
  return { user, token: signAccessToken({ userId: user.id, role: "DRIVER" }) };
}

const patchZone = (token: string, body: unknown) =>
  app.inject({
    method: "PATCH",
    url: "/driver/zone",
    headers: { authorization: `Bearer ${token}` },
    payload: body as Record<string, unknown>,
  });

describe("PATCH /driver/zone", () => {
  it("moves an online driver's current zone", async () => {
    const { pickup, dropoff } = await getTestZones();
    const { user, token } = await driverWith({ isOnline: true, currentZoneId: pickup.id });

    const res = await patchZone(token, { zoneId: dropoff.id });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ zoneId: dropoff.id });
    const driver = await prisma.driver.findUniqueOrThrow({ where: { userId: user.id } });
    expect(driver.currentZoneId).toBe(dropoff.id);
    expect(driver.isOnline).toBe(true);
  });

  it("refuses an offline driver and never flips them online", async () => {
    const { pickup } = await getTestZones();
    const { user, token } = await driverWith({ isOnline: false, currentZoneId: null });

    const res = await patchZone(token, { zoneId: pickup.id });

    expect(res.statusCode).toBe(409);
    const driver = await prisma.driver.findUniqueOrThrow({ where: { userId: user.id } });
    expect(driver.isOnline).toBe(false);
    expect(driver.currentZoneId).toBeNull();
  });

  it("validates the body and the zone", async () => {
    const { token } = await driverWith({ isOnline: true });
    expect((await patchZone(token, {})).statusCode).toBe(400);
    expect((await patchZone(token, { zoneId: 7 })).statusCode).toBe(400);
    expect((await patchZone(token, { zoneId: "no-such-zone" })).statusCode).toBe(404);
  });

  it("is drivers only", async () => {
    const { pickup } = await getTestZones();
    const riderToken = signAccessToken({ userId: "someone", role: "RIDER" });
    expect((await patchZone(riderToken, { zoneId: pickup.id })).statusCode).toBe(403);
  });

  it("changes which requests the driver is shown", async () => {
    const { pickup, dropoff } = await getTestZones();
    // Online, last seen in another zone; moving into the pickup zone makes
    // the request eligible whatever the test DB's adjacency looks like.
    const { token } = await driverWith({ isOnline: true, currentZoneId: dropoff.id });
    const { ride } = await createTestRide({
      type: "LONE",
      status: "REQUESTED",
      pickupZoneId: pickup.id,
      dropoffZoneId: dropoff.id,
      broadcastStartedAt: new Date(),
    });
    createdRideIds.push(ride.id);

    await patchZone(token, { zoneId: pickup.id });
    const eligible = await app.inject({
      method: "GET",
      url: "/driver/rides/eligible",
      headers: { authorization: `Bearer ${token}` },
    });
    const item = eligible.json().rides.find((r: { rideId: string }) => r.rideId === ride.id);
    expect(item).toBeDefined();
    // Additive field for the "Requests near you" card.
    expect(item.seats).toBe(1);
  });
});

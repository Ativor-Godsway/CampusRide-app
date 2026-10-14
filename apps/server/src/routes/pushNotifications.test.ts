/**
 * Which ride events send a push notification, to whom, and that a push
 * failure never breaks the ride flow. The Expo transport is a fake
 * (services/push/pushService.test.ts) — nothing leaves the machine.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { prisma } from "../db/prisma";
import { registerDriverRoutes } from "./driver";
import { registerRideRoutes } from "./rides";
import { registerPushRoutes } from "./push";
import { signAccessToken } from "../services/auth/tokens";
import {
  cleanupDriver,
  createTestDriver,
  createTestRide,
  createTestUser,
} from "../services/ride/testFixtures";
import { broadcastRide } from "../services/ride/dispatch";
import { processTimeouts } from "../services/ride/timeouts";
import {
  registerPushToken,
  resetPushStateForTests,
  setPushTransportForTests,
} from "../services/push/pushService";
import { checkDriverArriving, resetArrivingChecksForTests } from "../services/push/notify";
import { fakeTransport, newToken } from "../services/push/testFixtures";

vi.mock("../services/sms/sendSms", () => ({
  sendSms: vi.fn().mockResolvedValue({ success: true }),
}));

let app: FastifyInstance;
let fake: ReturnType<typeof fakeTransport>;
const rideIds: string[] = [];
const driverIds: string[] = [];
const userIds: string[] = [];

beforeAll(async () => {
  app = Fastify();
  registerDriverRoutes(app, prisma);
  registerRideRoutes(app, prisma);
  registerPushRoutes(app, prisma);
  await app.ready();
});

beforeEach(() => {
  resetPushStateForTests();
  resetArrivingChecksForTests();
  fake = fakeTransport();
  setPushTransportForTests(fake.transport);
});

afterEach(async () => {
  const rides = await prisma.ride.findMany({
    where: { id: { in: rideIds } },
    include: { passengers: true },
  });
  const riders = new Set([
    ...userIds,
    ...rides.flatMap((r) => [r.riderId, ...r.passengers.map((p) => p.riderId)]),
  ]);
  await prisma.pushToken.deleteMany({ where: { userId: { in: [...riders, ...driverIds] } } });
  await prisma.rideRejection.deleteMany({ where: { rideId: { in: rideIds } } });
  await prisma.ridePassenger.deleteMany({ where: { rideId: { in: rideIds } } });
  await prisma.commissionLedger.deleteMany({ where: { rideId: { in: rideIds } } });
  await prisma.ride.updateMany({
    where: { id: { in: rideIds } },
    data: { mergedIntoRideId: null },
  });
  await prisma.ride.deleteMany({ where: { id: { in: rideIds } } });
  await prisma.user.deleteMany({ where: { id: { in: [...riders] } } });
  rideIds.length = 0;
  userIds.length = 0;
  while (driverIds.length) await cleanupDriver(driverIds.pop()!);
});

afterAll(async () => {
  setPushTransportForTests(null);
  await app.close();
});

async function withToken(userId: string, role: "RIDER" | "DRIVER") {
  const token = newToken();
  await registerPushToken(
    prisma,
    { userId, role },
    { token, app: role === "RIDER" ? "rider" : "driver", platform: "android" },
  );
  return token;
}

async function driver(name = "Kofi Mensah", zoneId: string | null = null) {
  const { user } = await createTestDriver({
    isOnline: true,
    isApproved: true,
    currentZoneId: zoneId,
  });
  driverIds.push(user.id);
  await prisma.user.update({ where: { id: user.id }, data: { name } });
  return {
    user,
    auth: { authorization: `Bearer ${signAccessToken({ userId: user.id, role: "DRIVER" })}` },
  };
}

/** A matched car with one waiting rider who has the app and notifications on. */
async function carWithRider(
  status: "WAITING" | "ARRIVED" | "PICKED_UP" = "WAITING",
  rideStatus: "MATCHED" | "ARRIVED" | "IN_PROGRESS" = "MATCHED",
) {
  const d = await driver();
  const rider = await createTestUser("RIDER");
  userIds.push(rider.id);
  const { ride } = await createTestRide({
    type: "LONE",
    status: rideStatus,
    driverId: d.user.id,
    passengers: [{ riderId: rider.id, status, lockedFare: 500 }],
  });
  rideIds.push(ride.id);
  const token = await withToken(rider.id, "RIDER");
  return { ...d, rider, ride, seat: ride.passengers[0]!, token };
}

const kinds = () => fake.sent.map((m) => (m.data as { kind: string }).kind);

describe("rider notifications from driver actions", () => {
  it("driver arrived: to that rider, naming the driver by first name", async () => {
    const { ride, seat, auth, token } = await carWithRider();
    const res = await app.inject({
      method: "POST",
      url: `/rides/${ride.id}/passengers/${seat.id}/arrived`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
    expect(fake.sent[0]).toMatchObject({
      to: token,
      body: "Kofi is at your pickup.",
      data: { kind: "DRIVER_ARRIVED", rideId: ride.id },
    });
  });

  it("trip started and trip completed", async () => {
    const { ride, seat, auth } = await carWithRider("ARRIVED", "ARRIVED");
    await app.inject({
      method: "POST",
      url: `/rides/${ride.id}/passengers/${seat.id}/pickup`,
      headers: auth,
    });
    await vi.waitFor(() => expect(kinds()).toEqual(["TRIP_STARTED"]));
    await app.inject({
      method: "POST",
      url: `/rides/${ride.id}/passengers/${seat.id}/dropoff`,
      headers: auth,
    });
    await vi.waitFor(() => expect(kinds()).toEqual(["TRIP_STARTED", "TRIP_COMPLETED"]));
  });

  it("driver cancelled the pickup, and the no-show version", async () => {
    const waiting = await carWithRider();
    await app.inject({
      method: "POST",
      url: `/rides/${waiting.ride.id}/passengers/${waiting.seat.id}/cancel`,
      headers: waiting.auth,
    });
    await vi.waitFor(() => expect(kinds()).toEqual(["DRIVER_CANCELLED"]));
    expect(fake.sent[0]!.body).toContain("request another ride");

    const arrived = await carWithRider("ARRIVED", "ARRIVED");
    await prisma.ridePassenger.update({
      where: { id: arrived.seat.id },
      data: { arrivedAt: new Date(Date.now() - 10 * 60_000) },
    });
    const res = await app.inject({
      method: "POST",
      url: `/rides/${arrived.ride.id}/passengers/${arrived.seat.id}/cancel`,
      headers: arrived.auth,
      payload: { reason: "NO_SHOW" },
    });
    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect(fake.sent).toHaveLength(2));
    expect(fake.sent[1]!.body).toContain("couldn't find you");
  });

  it("a push failure never breaks the action", async () => {
    const { ride, seat, auth } = await carWithRider();
    fake.failSends();
    const res = await app.inject({
      method: "POST",
      url: `/rides/${ride.id}/passengers/${seat.id}/arrived`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const after = await prisma.ridePassenger.findUniqueOrThrow({ where: { id: seat.id } });
    expect(after.status).toBe("ARRIVED");
  });

  it("driver assigned: when a driver accepts the request", async () => {
    const d = await driver("Yaw Owusu");
    const { ride, rider } = await createTestRide({
      type: "LONE",
      status: "REQUESTED",
      broadcastStartedAt: new Date(),
    });
    rideIds.push(ride.id);
    const token = await withToken(rider.id, "RIDER");
    const res = await app.inject({
      method: "POST",
      url: `/rides/${ride.id}/claim`,
      headers: d.auth,
    });
    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
    expect(fake.sent[0]).toMatchObject({
      to: token,
      body: "Yaw is coming to pick you up.",
      data: { kind: "DRIVER_ASSIGNED" },
    });
  });

  it("driver arriving: once, when the driver comes close to a rider still waiting", async () => {
    const { ride, seat, user } = await carWithRider();
    const pickup = { latitude: 5.6505, longitude: -0.1869 };
    await prisma.ridePassenger.update({
      where: { id: seat.id },
      data: {
        pickupLat: pickup.latitude,
        pickupLng: pickup.longitude,
        createdAt: new Date(Date.now() - 5 * 60_000),
      },
    });
    // Far away: nothing.
    checkDriverArriving(
      prisma,
      ride.id,
      user.id,
      { latitude: 5.6595, longitude: -0.1869 },
      new Date(),
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(fake.sent).toHaveLength(0);
    // Close (checks are throttled per ride, so move the clock on).
    const later = new Date(Date.now() + 20_000);
    checkDriverArriving(prisma, ride.id, user.id, { latitude: 5.6523, longitude: -0.1869 }, later);
    await vi.waitFor(() => expect(kinds()).toEqual(["DRIVER_ARRIVING"]));
    // Still close a little later: not again.
    checkDriverArriving(
      prisma,
      ride.id,
      user.id,
      { latitude: 5.651, longitude: -0.1869 },
      new Date(later.getTime() + 20_000),
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(kinds()).toEqual(["DRIVER_ARRIVING"]);
  });
});

describe("other events", () => {
  it("no driver found: when the search window runs out", async () => {
    const start = new Date(Date.now() - 5 * 60_000);
    const { ride, rider } = await createTestRide({
      type: "SHARED",
      status: "REQUESTED",
      broadcastStartedAt: start,
      createdAt: start,
    });
    rideIds.push(ride.id);
    const token = await withToken(rider.id, "RIDER");
    await processTimeouts(prisma, new Date(), {
      rideIds: [ride.id],
      logger: { info: () => {}, warn: () => {} },
    });
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
    expect(fake.sent[0]).toMatchObject({
      to: token,
      data: { kind: "NO_DRIVER_FOUND", rideId: ride.id },
    });
  });

  it("rider cancelled: tells the driver who had accepted, by the rider's first name", async () => {
    const { ride, rider, user } = await carWithRider();
    await prisma.ride.update({ where: { id: ride.id }, data: { riderId: rider.id } });
    await prisma.user.update({ where: { id: rider.id }, data: { name: "Ama Serwaa" } });
    const driverToken = await withToken(user.id, "DRIVER");
    const res = await app.inject({
      method: "POST",
      url: `/rides/${ride.id}/cancel`,
      headers: { authorization: `Bearer ${signAccessToken({ userId: rider.id, role: "RIDER" })}` },
    });
    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
    expect(fake.sent[0]).toMatchObject({
      to: driverToken,
      body: "Ama cancelled the ride.",
      channelId: "ride-requests",
      data: { kind: "RIDER_CANCELLED", rideId: ride.id },
    });
  });

  it("new ride request: to free drivers nearby, not to a driver mid-trip", async () => {
    const { ride, pickup } = await createTestRide({
      type: "LONE",
      status: "REQUESTED",
      broadcastStartedAt: new Date(),
    });
    rideIds.push(ride.id);
    const free = await driver("Free Driver", pickup.id);
    const busy = await driver("Busy Driver", pickup.id);
    const freeToken = await withToken(free.user.id, "DRIVER");
    await withToken(busy.user.id, "DRIVER");
    const { ride: busyTrip } = await createTestRide({
      type: "LONE",
      status: "IN_PROGRESS",
      driverId: busy.user.id,
    });
    rideIds.push(busyTrip.id);

    await broadcastRide(prisma, ride.id);
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
    expect(fake.sent[0]).toMatchObject({
      to: freeToken,
      title: "New ride request",
      data: { kind: "RIDE_REQUEST", rideId: ride.id },
    });
    expect(fake.sent[0]!.body).toMatch(/^Pickup at .+\. Open the app to accept\.$/);
  });
});

describe("push token routes", () => {
  it("registers and removes this install's token", async () => {
    const rider = await createTestUser("RIDER");
    userIds.push(rider.id);
    const auth = {
      authorization: `Bearer ${signAccessToken({ userId: rider.id, role: "RIDER" })}`,
    };
    const token = newToken();
    const put = await app.inject({
      method: "PUT",
      url: "/me/push-token",
      headers: auth,
      payload: { token, app: "rider", platform: "android" },
    });
    expect(put.statusCode).toBe(200);
    expect(await prisma.pushToken.count({ where: { userId: rider.id } })).toBe(1);

    const bad = await app.inject({
      method: "PUT",
      url: "/me/push-token",
      headers: auth,
      payload: { token, app: "driver", platform: "android" },
    });
    expect(bad.statusCode).toBe(400);

    const del = await app.inject({
      method: "DELETE",
      url: "/me/push-token",
      headers: auth,
      payload: { token },
    });
    expect(del.statusCode).toBe(200);
    expect(await prisma.pushToken.count({ where: { userId: rider.id } })).toBe(0);
  });

  it("needs a signed-in user", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/me/push-token",
      payload: { token: newToken(), app: "rider", platform: "android" },
    });
    expect(res.statusCode).toBe(401);
  });
});

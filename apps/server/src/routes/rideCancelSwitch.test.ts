import { describe, it, expect, afterEach, afterAll, beforeAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { getLoneFare, getSharedFarePerRider, RIDER_CANCEL_NOTE_MAX } from "@rida/shared";
import type { RideStatus, RideType } from "@rida/shared";
import { prisma } from "../db/prisma";
import { config } from "../config";
import { registerRideRoutes } from "./rides";
import { registerAdminRoutes } from "./admin";
import { signAccessToken } from "../services/auth/tokens";
import {
  cleanupDriver,
  cleanupRide,
  createTestDriver,
  createTestRide,
  createTestUser,
} from "../services/ride/testFixtures";

/**
 * The rider cancel sheet (reason + note) and the Shared <-> Ride alone
 * switch, exercised through the real routes with the rate limiter
 * registered as in production.
 */
let app: FastifyInstance;
const rideIds: string[] = [];
const userIds: string[] = [];
const driverUserIds: string[] = [];

beforeAll(async () => {
  app = Fastify();
  // global: false — only routes that declare their own limit are limited,
  // which isolates the per-user limits under test from the global cap.
  await app.register(rateLimit, { global: false });
  registerRideRoutes(app, prisma);
  registerAdminRoutes(app, prisma);
  await app.ready();
});

afterEach(async () => {
  while (rideIds.length > 0) await cleanupRide(rideIds.pop()!);
  while (driverUserIds.length > 0) await cleanupDriver(driverUserIds.pop()!);
  if (userIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: userIds.splice(0) } } });
  }
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

/** A searching ride whose requester is its single passenger, as createRide makes it. */
async function searchingRide(
  type: RideType,
  opts: { status?: RideStatus; driverId?: string | null } = {},
) {
  const { ride, rider } = await createTestRide({
    type,
    status: opts.status ?? "REQUESTED",
    driverId: opts.driverId ?? null,
    broadcastStartedAt: new Date(Date.now() - 30_000),
  });
  rideIds.push(ride.id);
  await prisma.ridePassenger.create({
    data: {
      rideId: ride.id,
      riderId: rider.id,
      pickupZoneId: ride.pickupZoneId,
      dropoffZoneId: ride.dropoffZoneId,
      status: "WAITING",
      lockedFare: type === "LONE" ? getLoneFare() : getSharedFarePerRider(1),
    },
  });
  return { ride, rider, token: signAccessToken({ userId: rider.id, role: "RIDER" }) };
}

async function strangerToken() {
  const other = await createTestUser("RIDER");
  userIds.push(other.id);
  return signAccessToken({ userId: other.id, role: "RIDER" });
}

async function assignedDriver() {
  const { user } = await createTestDriver({ isOnline: true, isApproved: true });
  driverUserIds.push(user.id);
  return user;
}

function cancel(rideId: string, token: string, payload?: object) {
  return app.inject({
    method: "POST",
    url: `/rides/${rideId}/cancel`,
    headers: { authorization: `Bearer ${token}` },
    ...(payload ? { payload } : {}),
  });
}

function switchTo(rideId: string, token: string, type: unknown) {
  return app.inject({
    method: "POST",
    url: `/rides/${rideId}/switch`,
    headers: { authorization: `Bearer ${token}` },
    payload: { type },
  });
}

describe("POST /rides/:id/cancel with a reason", () => {
  it("stores the rider's reason and note beside the system cancelReason", async () => {
    const { ride, token } = await searchingRide("SHARED");
    const res = await cancel(ride.id, token, { reason: "OTHER", note: "  Class got moved  " });
    expect(res.statusCode).toBe(200);

    const row = await prisma.ride.findUniqueOrThrow({ where: { id: ride.id } });
    expect(row.status).toBe("CANCELLED");
    expect(row.cancelReason).toBe("RIDER_CANCELLED");
    expect(row.riderCancelReason).toBe("OTHER");
    expect(row.riderCancelNote).toBe("Class got moved");
  });

  it("still cancels with no body, for app builds that predate the sheet", async () => {
    const { ride, token } = await searchingRide("LONE");
    const res = await cancel(ride.id, token);
    expect(res.statusCode).toBe(200);

    const row = await prisma.ride.findUniqueOrThrow({ where: { id: ride.id } });
    expect(row.status).toBe("CANCELLED");
    expect(row.riderCancelReason).toBeNull();
  });

  it("rejects an unknown reason and leaves the ride searching", async () => {
    const { ride, token } = await searchingRide("SHARED");
    const res = await cancel(ride.id, token, { reason: "BORED" });
    expect(res.statusCode).toBe(400);

    const row = await prisma.ride.findUniqueOrThrow({ where: { id: ride.id } });
    expect(row.status).toBe("REQUESTED");
  });

  it(`rejects a note longer than ${RIDER_CANCEL_NOTE_MAX} characters`, async () => {
    const { ride, token } = await searchingRide("SHARED");
    const res = await cancel(ride.id, token, {
      reason: "OTHER",
      note: "x".repeat(RIDER_CANCEL_NOTE_MAX + 1),
    });
    expect(res.statusCode).toBe(400);
    expect((await prisma.ride.findUniqueOrThrow({ where: { id: ride.id } })).status).toBe(
      "REQUESTED",
    );
  });

  it("refuses a driver-stage reason while still searching", async () => {
    const { ride, token } = await searchingRide("SHARED");
    const res = await cancel(ride.id, token, { reason: "DRIVER_ASKED_TO_CANCEL" });
    expect(res.statusCode).toBe(400);
  });

  it("accepts DRIVER_ASKED_TO_CANCEL once a driver is assigned, and flags it for admins", async () => {
    const driver = await assignedDriver();
    const { ride, token } = await searchingRide("LONE", { status: "MATCHED", driverId: driver.id });
    const res = await cancel(ride.id, token, { reason: "DRIVER_ASKED_TO_CANCEL" });
    expect(res.statusCode).toBe(200);

    const admin = await createTestUser("RIDER");
    userIds.push(admin.id);
    const list = await app.inject({
      method: "GET",
      url: "/admin/rides?status=CANCELLED&limit=200",
      headers: { authorization: `Bearer ${signAccessToken({ userId: admin.id, role: "ADMIN" })}` },
    });
    expect(list.statusCode).toBe(200);
    const row = list.json().rides.find((r: { id: string }) => r.id === ride.id);
    expect(row).toMatchObject({
      riderCancelReason: "DRIVER_ASKED_TO_CANCEL",
      riderCancelReasonLabel: "Driver asked me to cancel",
      riderCancelFlagged: true,
    });
  });

  it("does not let another rider cancel my ride", async () => {
    const { ride } = await searchingRide("SHARED");
    const res = await cancel(ride.id, await strangerToken(), { reason: "PRICE" });
    expect(res.statusCode).toBe(403);

    const row = await prisma.ride.findUniqueOrThrow({ where: { id: ride.id } });
    expect(row.status).toBe("REQUESTED");
    expect(row.riderCancelReason).toBeNull();
  });
});

describe("POST /rides/:id/switch", () => {
  it("Shared -> Ride alone WHILE STILL SEARCHING: same ride, lone fare, fresh broadcast", async () => {
    const { ride, token } = await searchingRide("SHARED");
    const res = await switchTo(ride.id, token, "LONE");
    expect(res.statusCode).toBe(200);
    expect(res.json().farePesewas).toBe(getLoneFare());

    const row = await prisma.ride.findUniqueOrThrow({
      where: { id: ride.id },
      include: { passengers: true },
    });
    expect(row.type).toBe("LONE");
    expect(row.status).toBe("REQUESTED");
    expect(row.passengers[0]!.lockedFare).toBe(getLoneFare());
    expect(row.broadcastStartedAt!.getTime()).toBeGreaterThan(ride.broadcastStartedAt!.getTime());

    // Never two rides, never none: the rider still has exactly this one.
    const active = await prisma.ride.count({
      where: { riderId: ride.riderId, status: { notIn: ["CANCELLED", "COMPLETED"] } },
    });
    expect(active).toBe(1);
  });

  it("Ride alone -> Shared: shared fare", async () => {
    const { ride, token } = await searchingRide("LONE");
    const res = await switchTo(ride.id, token, "SHARED");
    expect(res.statusCode).toBe(200);
    expect(res.json().farePesewas).toBe(getSharedFarePerRider(1));

    const row = await prisma.ride.findUniqueOrThrow({
      where: { id: ride.id },
      include: { passengers: true },
    });
    expect(row.type).toBe("SHARED");
    expect(row.passengers[0]!.lockedFare).toBe(getSharedFarePerRider(1));
  });

  it("works from the no-drivers state (AWAITING_RIDER_DECISION), re-broadcasting", async () => {
    const { ride, token } = await searchingRide("SHARED", { status: "AWAITING_RIDER_DECISION" });
    const res = await switchTo(ride.id, token, "LONE");
    expect(res.statusCode).toBe(200);

    const row = await prisma.ride.findUniqueOrThrow({ where: { id: ride.id } });
    expect(row.status).toBe("REQUESTED");
    expect(row.decisionStartedAt).toBeNull();
  });

  it("refuses once a driver has claimed the ride, changing nothing", async () => {
    const driver = await assignedDriver();
    const { ride, token } = await searchingRide("SHARED", {
      status: "MATCHED",
      driverId: driver.id,
    });
    const res = await switchTo(ride.id, token, "LONE");
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("RIDE_NOT_SWITCHABLE");

    const row = await prisma.ride.findUniqueOrThrow({ where: { id: ride.id } });
    expect(row.type).toBe("SHARED");
    expect(row.status).toBe("MATCHED");
  });

  it("refuses switching to the type the ride already is", async () => {
    const { ride, token } = await searchingRide("LONE");
    const res = await switchTo(ride.id, token, "LONE");
    expect(res.statusCode).toBe(409);
  });

  it("refuses a car holding more than one rider, rolling back", async () => {
    const { ride, token } = await searchingRide("SHARED");
    const other = await createTestUser("RIDER");
    await prisma.ridePassenger.create({
      data: {
        rideId: ride.id,
        riderId: other.id,
        pickupZoneId: ride.pickupZoneId,
        dropoffZoneId: ride.dropoffZoneId,
        status: "WAITING",
        lockedFare: getSharedFarePerRider(1),
      },
    });
    const res = await switchTo(ride.id, token, "LONE");
    expect(res.statusCode).toBe(409);

    const row = await prisma.ride.findUniqueOrThrow({ where: { id: ride.id } });
    expect(row.type).toBe("SHARED");
  });

  it("rejects a bad type", async () => {
    const { ride, token } = await searchingRide("SHARED");
    expect((await switchTo(ride.id, token, "LIMO")).statusCode).toBe(400);
  });

  it("does not let another rider switch my ride", async () => {
    const { ride } = await searchingRide("SHARED");
    const res = await switchTo(ride.id, await strangerToken(), "LONE");
    expect(res.statusCode).toBe(403);
    expect((await prisma.ride.findUniqueOrThrow({ where: { id: ride.id } })).type).toBe("SHARED");
  });

  it("rate-limits per rider, not per IP", async () => {
    const { ride, token } = await searchingRide("LONE");
    const max = config.rateLimit.rideSwitchMax;
    // Same-type switches are refused (409) but still count towards the limit.
    for (let i = 0; i < max; i++) {
      expect((await switchTo(ride.id, token, "LONE")).statusCode).toBe(409);
    }
    expect((await switchTo(ride.id, token, "LONE")).statusCode).toBe(429);

    // Another rider from the same (test) IP is unaffected.
    const { ride: theirs, token: theirToken } = await searchingRide("SHARED");
    expect((await switchTo(theirs.id, theirToken, "LONE")).statusCode).toBe(200);
  });
});

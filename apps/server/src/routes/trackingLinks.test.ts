/**
 * SOS tracking links (GET /track/:token): one per rider per ride, about that
 * rider only, and gone TRACKING_LINK_TTL_HOURS after the ride ends.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { prisma } from "../db/prisma";
import { config } from "../config";
import { registerSafetyRoutes } from "./safety";
import { signAccessToken } from "../services/auth/tokens";
import { isTrackingLinkExpired } from "./safety";
import { createTestDriver, createTestUser, getTestZones } from "../services/ride/testFixtures";

vi.mock("../services/sms/sendSms", () => ({
  sendSms: vi.fn().mockResolvedValue({ success: true }),
}));

let app: FastifyInstance;
const userIds: string[] = [];

beforeAll(async () => {
  app = Fastify();
  registerSafetyRoutes(app, prisma);
  await app.ready();
});

afterAll(async () => {
  await prisma.ride.deleteMany({
    where: { OR: [{ riderId: { in: userIds } }, { driverId: { in: userIds } }] },
  });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

/** A shared car: Ama booked it, Kwame was added, both still to be dropped off. */
async function sharedCar() {
  const ama = await createTestUser("RIDER");
  const kwame = await createTestUser("RIDER");
  const { user: driver } = await createTestDriver({ isOnline: true, isApproved: true });
  userIds.push(ama.id, kwame.id, driver.id);
  await prisma.user.update({ where: { id: ama.id }, data: { name: "Ama Booker" } });
  await prisma.user.update({ where: { id: kwame.id }, data: { name: "Kwame Passenger" } });
  const { pickup, dropoff } = await getTestZones();
  const ride = await prisma.ride.create({
    data: {
      riderId: ama.id,
      driverId: driver.id,
      type: "SHARED",
      status: "IN_PROGRESS",
      pickupZoneId: pickup.id,
      dropoffZoneId: dropoff.id,
      occupancy: 2,
      pickupLabel: "Balme Library",
      dropoffLabel: "Night Market",
      passengers: {
        create: [
          {
            riderId: ama.id,
            pickupZoneId: pickup.id,
            dropoffZoneId: dropoff.id,
            status: "PICKED_UP",
            pickupLabel: "Balme Library",
            dropoffLabel: "Night Market",
          },
          {
            riderId: kwame.id,
            pickupZoneId: pickup.id,
            dropoffZoneId: dropoff.id,
            status: "PICKED_UP",
            pickupLabel: "Volta Hall",
            dropoffLabel: "Akuafo Hall",
          },
        ],
      },
    },
  });
  return { ride, ama, kwame };
}

async function sos(rideId: string, userId: string) {
  const res = await app.inject({
    method: "POST",
    url: `/rides/${rideId}/sos`,
    headers: { authorization: `Bearer ${signAccessToken({ userId, role: "RIDER" })}` },
  });
  expect(res.statusCode).toBe(200);
  return new URL(res.json().trackingUrl as string).pathname;
}

describe("a tracking link is about the rider who raised the SOS", () => {
  it("a passenger's link shows the passenger and their own stops — not the booking rider", async () => {
    const { ride, ama, kwame } = await sharedCar();
    const page = (await app.inject({ method: "GET", url: await sos(ride.id, kwame.id) })).body;

    expect(page).toContain("Kwame Passenger");
    expect(page).toContain("Volta Hall");
    expect(page).toContain("Akuafo Hall");
    expect(page).toContain(`tel:${kwame.phone}`);
    expect(page).not.toContain("Ama Booker");
    expect(page).not.toContain(ama.phone);
    expect(page).not.toContain("Balme Library");
  });

  it("each rider gets their own link, and pressing SOS again keeps it", async () => {
    const { ride, ama, kwame } = await sharedCar();
    const amaLink = await sos(ride.id, ama.id);
    const kwameLink = await sos(ride.id, kwame.id);
    expect(amaLink).not.toBe(kwameLink);
    expect(await sos(ride.id, kwame.id)).toBe(kwameLink);
    expect(await prisma.trackingLink.count({ where: { rideId: ride.id } })).toBe(2);
    // New links never touch the ride row's legacy column (which drivers' ride payloads include).
    expect(
      (await prisma.ride.findUniqueOrThrow({ where: { id: ride.id } })).trackingToken,
    ).toBeNull();
  });
});

describe("links expire after the ride ends", () => {
  it("work during the ride and for TRACKING_LINK_TTL_HOURS after, then answer 410", async () => {
    const { ride, kwame } = await sharedCar();
    const link = await sos(ride.id, kwame.id);
    const ttlMs = config.trackingLinkTtlHours * 60 * 60 * 1000;

    expect((await app.inject({ method: "GET", url: link })).statusCode).toBe(200);

    await prisma.ride.update({
      where: { id: ride.id },
      data: { status: "COMPLETED", completedAt: new Date(Date.now() - ttlMs + 60_000) },
    });
    const justEnded = await app.inject({ method: "GET", url: link });
    expect(justEnded.statusCode).toBe(200);
    expect(justEnded.body).toContain("This trip has ended");

    await prisma.ride.update({
      where: { id: ride.id },
      data: { completedAt: new Date(Date.now() - ttlMs - 60_000) },
    });
    await prisma.trackingLink.updateMany({
      where: { rideId: ride.id },
      data: { createdAt: new Date(Date.now() - ttlMs - 120_000) },
    });
    const expired = await app.inject({ method: "GET", url: link });
    expect(expired.statusCode).toBe(410);
    expect(expired.body).not.toContain("Kwame");
  });

  it("measures a cancelled ride (no end time recorded) from the SOS", () => {
    const now = new Date("2026-10-15T12:00:00Z");
    const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
    expect(
      isTrackingLinkExpired({ createdAt: hoursAgo(23), ride: { completedAt: null } }, 24, now),
    ).toBe(false);
    expect(
      isTrackingLinkExpired({ createdAt: hoursAgo(25), ride: { completedAt: null } }, 24, now),
    ).toBe(true);
    // Completed: from completion, which is after the SOS.
    expect(
      isTrackingLinkExpired(
        { createdAt: hoursAgo(30), ride: { completedAt: hoursAgo(2) } },
        24,
        now,
      ),
    ).toBe(false);
  });
});

describe("the page itself", () => {
  it("is never cached, indexed, framed or allowed to run anything", async () => {
    const { ride, kwame } = await sharedCar();
    for (const url of [await sos(ride.id, kwame.id), `/track/${"0".repeat(32)}`]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.headers["x-robots-tag"]).toBe("noindex, nofollow");
      expect(res.headers["referrer-policy"]).toBe("no-referrer");
      expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
      expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    }
  });

  it("answers a malformed token 404 without looking it up", async () => {
    const spy = vi.spyOn(prisma.trackingLink, "findUnique");
    for (const bad of ["abc", "Z".repeat(32), `${"a".repeat(32)}x`]) {
      expect((await app.inject({ method: "GET", url: `/track/${bad}` })).statusCode).toBe(404);
    }
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

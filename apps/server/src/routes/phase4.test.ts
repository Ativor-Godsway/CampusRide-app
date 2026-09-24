/**
 * Phase 4 — safety and UX completeness.
 *
 * Covers the new backend surface: rider profile edit + emergency contact,
 * SOS and its public tracking page, driver->rider ratings, explicit driver
 * reject, the earnings commission/net breakdown, and ride-history pagination.
 */
import { describe, it, expect, vi, afterEach, afterAll, beforeAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { getLoneFare, splitFare } from "@rida/shared";
import { prisma } from "../db/prisma";
import { config } from "../config";
import { registerAuthRoutes } from "./auth";
import { registerRideRoutes } from "./rides";
import { registerDriverRoutes } from "./driver";
import { registerRatingRoutes } from "./ratings";
import { registerSafetyRoutes } from "./safety";
import { signAccessToken } from "../services/auth/tokens";
import { otpService } from "../services/active";
import { applyRideTransition } from "../services/ride/rideService";
import { riderDecision } from "../services/ride/riderDecision";
import {
  createTestDriver,
  createTestRide,
  createTestUser,
  getTestZones,
  cleanupDriver,
  cleanupRide,
} from "../services/ride/testFixtures";

vi.mock("../services/sms/sendSms", () => ({
  sendSms: vi.fn().mockResolvedValue({ success: true }),
}));
import { sendSms } from "../services/sms/sendSms";
import { SMS_SEGMENT_LIMIT } from "../services/safety/sos";

/**
 * The support backstop number. Injected into config for these tests — the
 * real value comes from SUPPORT_CONTACT_PHONE and is unset in .env.test, so
 * without this the support path would be silently skipped.
 */
const SUPPORT_PHONE = "+233555000999";
vi.spyOn(config, "supportContactPhone", "get").mockReturnValue(SUPPORT_PHONE);

let app: FastifyInstance;
const createdRideIds: string[] = [];
const createdDriverUserIds: string[] = [];
const createdUserIds: string[] = [];
/**
 * Riders that own MANY rides. cleanupRide() deletes a ride and then tries to
 * delete its users, which trips Ride_riderId_fkey while that rider still owns
 * other rides — so these are torn down rides-first, rider-last instead.
 */
const multiRideRiderIds: string[] = [];

beforeAll(async () => {
  app = Fastify();
  registerAuthRoutes(app, prisma, otpService);
  registerRideRoutes(app, prisma);
  registerDriverRoutes(app, prisma);
  registerRatingRoutes(app, prisma);
  registerSafetyRoutes(app, prisma);
  await app.ready();
});

afterEach(async () => {
  // Reset (not just clear): some tests install their own implementation.
  vi.mocked(sendSms).mockReset();
  vi.mocked(sendSms).mockResolvedValue({ success: true });
  while (createdRideIds.length > 0) await cleanupRide(createdRideIds.pop()!);
  while (createdDriverUserIds.length > 0) await cleanupDriver(createdDriverUserIds.pop()!);
  while (multiRideRiderIds.length > 0) {
    const riderId = multiRideRiderIds.pop()!;
    await prisma.ride.deleteMany({ where: { riderId } });
    await prisma.user.deleteMany({ where: { id: riderId } });
  }
  while (createdUserIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: createdUserIds.pop()! } });
  }
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

async function authedRider() {
  const rider = await createTestUser("RIDER");
  createdUserIds.push(rider.id);
  return { rider, token: signAccessToken({ userId: rider.id, role: "RIDER" }) };
}

async function authedDriver() {
  const { user } = await createTestDriver({ isOnline: true, isApproved: true });
  createdDriverUserIds.push(user.id);
  return { user, token: signAccessToken({ userId: user.id, role: "DRIVER" }) };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

// ── Task 4: rider profile edit ────────────────────────────────────────────────

describe("PATCH /me — rider profile", () => {
  it("requires auth", async () => {
    const res = await app.inject({ method: "PATCH", url: "/me", payload: { name: "X" } });
    expect(res.statusCode).toBe(401);
  });

  it("updates the display name and echoes the /me shape", async () => {
    const { rider, token } = await authedRider();

    const res = await app.inject({
      method: "PATCH",
      url: "/me",
      headers: auth(token),
      payload: { name: "  Ama Mensah  " },
    });

    expect(res.statusCode).toBe(200);
    // Trimmed, and returned in the same shape GET /me uses.
    expect(res.json().user.name).toBe("Ama Mensah");
    const row = await prisma.user.findUniqueOrThrow({ where: { id: rider.id } });
    expect(row.name).toBe("Ama Mensah");
  });

  it("rejects an empty name rather than wiping it", async () => {
    const { token } = await authedRider();
    const res = await app.inject({
      method: "PATCH",
      url: "/me",
      headers: auth(token),
      payload: { name: "   " },
    });
    expect(res.statusCode).toBe(400);
  });

  it("never lets phone be changed through this route", async () => {
    const { rider, token } = await authedRider();
    const before = rider.phone;

    await app.inject({
      method: "PATCH",
      url: "/me",
      headers: auth(token),
      payload: { name: "New Name", phone: "+233200000123" },
    });

    const row = await prisma.user.findUniqueOrThrow({ where: { id: rider.id } });
    expect(row.phone).toBe(before);
  });

  it("sets an emergency contact", async () => {
    const { rider, token } = await authedRider();

    const res = await app.inject({
      method: "PATCH",
      url: "/me",
      headers: auth(token),
      payload: { emergencyContactName: "Kofi", emergencyContactPhone: "+233240000000" },
    });

    expect(res.statusCode).toBe(200);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: rider.id } });
    expect(row.emergencyContactName).toBe("Kofi");
    expect(row.emergencyContactPhone).toBe("+233240000000");
  });

  it("rejects a half-set contact in either direction", async () => {
    const { token } = await authedRider();

    const nameOnly = await app.inject({
      method: "PATCH",
      url: "/me",
      headers: auth(token),
      payload: { emergencyContactName: "Kofi" },
    });
    expect(nameOnly.statusCode).toBe(400);

    const phoneOnly = await app.inject({
      method: "PATCH",
      url: "/me",
      headers: auth(token),
      payload: { emergencyContactPhone: "+233240000000" },
    });
    expect(phoneOnly.statusCode).toBe(400);
  });

  it("rejects an implausible contact phone", async () => {
    const { token } = await authedRider();
    const res = await app.inject({
      method: "PATCH",
      url: "/me",
      headers: auth(token),
      payload: { emergencyContactName: "Kofi", emergencyContactPhone: "not-a-number" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("clears the contact when both fields are null", async () => {
    const { rider, token } = await authedRider();
    await app.inject({
      method: "PATCH",
      url: "/me",
      headers: auth(token),
      payload: { emergencyContactName: "Kofi", emergencyContactPhone: "+233240000000" },
    });

    const res = await app.inject({
      method: "PATCH",
      url: "/me",
      headers: auth(token),
      payload: { emergencyContactName: null, emergencyContactPhone: null },
    });

    expect(res.statusCode).toBe(200);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: rider.id } });
    expect(row.emergencyContactName).toBeNull();
    expect(row.emergencyContactPhone).toBeNull();
  });

  it("rejects an empty body", async () => {
    const { token } = await authedRider();
    const res = await app.inject({ method: "PATCH", url: "/me", headers: auth(token), payload: {} });
    expect(res.statusCode).toBe(400);
  });
});

// ── Task 1: SOS ───────────────────────────────────────────────────────────────

/** An IN_PROGRESS ride owned by a rider who has an emergency contact set. */
async function rideWithSosReadyRider(status: "IN_PROGRESS" | "COMPLETED" = "IN_PROGRESS") {
  const driver = await createTestDriver({ isOnline: true, isApproved: true });
  createdDriverUserIds.push(driver.user.id);
  await prisma.driver.update({
    where: { userId: driver.user.id },
    data: { plate: "GR-4321-24" },
  });

  const { ride, rider } = await createTestRide({
    type: "LONE",
    status,
    driverId: driver.user.id,
  });
  createdRideIds.push(ride.id);

  await prisma.user.update({
    where: { id: rider.id },
    data: { emergencyContactName: "Auntie Akos", emergencyContactPhone: "+233240000111" },
  });

  return { ride, rider, driver, token: signAccessToken({ userId: rider.id, role: "RIDER" }) };
}

describe("POST /rides/:id/sos", () => {
  it("requires auth", async () => {
    const res = await app.inject({ method: "POST", url: "/rides/x/sos" });
    expect(res.statusCode).toBe(401);
  });

  it("texts the emergency contact with status, route, driver and a tracking link", async () => {
    const { ride, token } = await rideWithSosReadyRider();

    const res = await app.inject({ method: "POST", url: `/rides/${ride.id}/sos`, headers: auth(token) });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.smsDelivered).toBe(true);
    expect(body.contactName).toBe("Auntie Akos");
    expect(body.trackingUrl).toContain("/track/");

    // Two recipients now: the rider's contact and the support backstop.
    expect(sendSms).toHaveBeenCalledTimes(2);
    const contactCall = vi
      .mocked(sendSms)
      .mock.calls.find(([phone]) => phone === "+233240000111");
    expect(contactCall).toBeDefined();

    const message = contactCall![1];
    expect(message).toContain("SOS");
    expect(message).toContain("On the trip");
    expect(message).toContain("GR-4321-24");
    expect(message).toContain(body.trackingUrl);
  });

  it("reuses the same tracking token across repeat SOS calls", async () => {
    const { ride, token } = await rideWithSosReadyRider();

    const first = await app.inject({ method: "POST", url: `/rides/${ride.id}/sos`, headers: auth(token) });
    const second = await app.inject({ method: "POST", url: `/rides/${ride.id}/sos`, headers: auth(token) });

    // A link already in the contact's hands must keep working.
    expect(first.json().trackingUrl).toBe(second.json().trackingUrl);
  });

  it("still reaches support when the rider saved no emergency contact", async () => {
    // The whole point of the support backstop: an SOS from a rider who never
    // set a contact used to be refused outright and reached nobody.
    const driver = await createTestDriver({ isOnline: true, isApproved: true });
    createdDriverUserIds.push(driver.user.id);
    const { ride, rider } = await createTestRide({
      type: "LONE",
      status: "IN_PROGRESS",
      driverId: driver.user.id,
    });
    createdRideIds.push(ride.id);
    const token = signAccessToken({ userId: rider.id, role: "RIDER" });

    const res = await app.inject({ method: "POST", url: `/rides/${ride.id}/sos`, headers: auth(token) });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hasEmergencyContact).toBe(false);
    expect(body.contactName).toBeNull();
    expect(body.supportNotified).toBe(true);
    expect(body.trackingUrl).toContain("/track/");

    // Exactly one SMS: support only.
    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendSms).mock.calls[0]![0]).toBe(SUPPORT_PHONE);
  });

  it("texts BOTH the rider's contact and support when a contact is set", async () => {
    const { ride, token } = await rideWithSosReadyRider();

    const res = await app.inject({ method: "POST", url: `/rides/${ride.id}/sos`, headers: auth(token) });

    expect(res.statusCode).toBe(200);
    expect(res.json().smsDelivered).toBe(true);
    expect(res.json().supportNotified).toBe(true);

    const recipients = vi.mocked(sendSms).mock.calls.map((c) => c[0]);
    expect(recipients).toHaveLength(2);
    expect(recipients).toContain("+233240000111");
    expect(recipients).toContain(SUPPORT_PHONE);
  });

  it("still reaches support when the rider's own contact fails", async () => {
    // The two sends are independent — neither may take the other down.
    vi.mocked(sendSms).mockImplementation(async (phone: string) =>
      phone === SUPPORT_PHONE ? { success: true } : Promise.reject(new Error("unreachable")),
    );
    const { ride, token } = await rideWithSosReadyRider();

    const res = await app.inject({ method: "POST", url: `/rides/${ride.id}/sos`, headers: auth(token) });

    expect(res.statusCode).toBe(200);
    expect(res.json().smsDelivered).toBe(false);
    expect(res.json().supportNotified).toBe(true);
  });

  it("refuses on a ride that is no longer active", async () => {
    const { ride, token } = await rideWithSosReadyRider("COMPLETED");

    const res = await app.inject({ method: "POST", url: `/rides/${ride.id}/sos`, headers: auth(token) });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("RIDE_NOT_ACTIVE");
  });

  it("forbids raising an SOS on someone else's ride", async () => {
    const { ride } = await rideWithSosReadyRider();
    const stranger = await authedRider();

    const res = await app.inject({
      method: "POST",
      url: `/rides/${ride.id}/sos`,
      headers: auth(stranger.token),
    });

    expect(res.statusCode).toBe(403);
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("still returns the tracking URL when the SMS provider fails", async () => {
    // A half-working SOS must not look like a broken button.
    vi.mocked(sendSms).mockRejectedValue(new Error("provider down"));
    const { ride, token } = await rideWithSosReadyRider();

    const res = await app.inject({ method: "POST", url: `/rides/${ride.id}/sos`, headers: auth(token) });

    expect(res.statusCode).toBe(200);
    expect(res.json().smsDelivered).toBe(false);
    expect(res.json().supportNotified).toBe(false);
    expect(res.json().trackingUrl).toContain("/track/");
  });

  it("uses the human status label, never the raw enum, and fits one SMS segment", async () => {
    const { ride, token } = await rideWithSosReadyRider();

    await app.inject({ method: "POST", url: `/rides/${ride.id}/sos`, headers: auth(token) });

    const message = vi.mocked(sendSms).mock.calls[0]![1];
    expect(message).toContain("On the trip");
    expect(message).not.toContain("IN_PROGRESS");
    expect(message.length).toBeLessThanOrEqual(SMS_SEGMENT_LIMIT);
  });

  it("does not put a 'call them' nudge in the SMS — that lives on the page", async () => {
    const { ride, token } = await rideWithSosReadyRider();
    await app.inject({ method: "POST", url: `/rides/${ride.id}/sos`, headers: auth(token) });

    const message = vi.mocked(sendSms).mock.calls[0]![1];
    expect(message.toLowerCase()).not.toContain("call");
  });
});

describe("GET /track/:token", () => {
  it("serves a public page for a valid token without auth", async () => {
    const { ride, token } = await rideWithSosReadyRider();
    const sos = await app.inject({ method: "POST", url: `/rides/${ride.id}/sos`, headers: auth(token) });
    const trackPath = new URL(sos.json().trackingUrl).pathname;

    const res = await app.inject({ method: "GET", url: trackPath });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("Driver on the way".replace("Driver on the way", "")); // status label present
    expect(res.body).toContain("GR-4321-24");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("never exposes the DRIVER's phone to the link holder", async () => {
    // The rider's own number IS shown (it powers the "call them now" nudge,
    // and the recipient is the rider's chosen contact who already has it).
    // The driver never consented to that, so their number must not appear in
    // any form — raw or dial-normalised.
    const { ride, driver, token } = await rideWithSosReadyRider();
    const sos = await app.inject({ method: "POST", url: `/rides/${ride.id}/sos`, headers: auth(token) });
    const trackPath = new URL(sos.json().trackingUrl).pathname;

    const res = await app.inject({ method: "GET", url: trackPath });

    const normalise = (value: string) => value.replace(/[\s()-]/g, "");
    expect(res.body).not.toContain(driver.user.phone);
    expect(normalise(res.body)).not.toContain(normalise(driver.user.phone));
  });

  it("carries the 'call them now' nudge that the SMS deliberately omits", async () => {
    const { ride, rider, token } = await rideWithSosReadyRider();
    const sos = await app.inject({ method: "POST", url: `/rides/${ride.id}/sos`, headers: auth(token) });
    const trackPath = new URL(sos.json().trackingUrl).pathname;

    const res = await app.inject({ method: "GET", url: trackPath });

    expect(res.body).toContain("call them now");
    // The nudge offers the RIDER's number — the person who raised the alarm,
    // and one this recipient already has. The DRIVER's stays withheld.
    expect(res.body).toContain(`tel:${rider.phone.replace(/[\s()-]/g, "")}`);
  });

  it("shows no call-to-action once the trip has ended", async () => {
    const { ride, token } = await rideWithSosReadyRider();
    const sos = await app.inject({ method: "POST", url: `/rides/${ride.id}/sos`, headers: auth(token) });
    const trackPath = new URL(sos.json().trackingUrl).pathname;

    await prisma.ride.update({ where: { id: ride.id }, data: { status: "COMPLETED" } });
    const res = await app.inject({ method: "GET", url: trackPath });

    expect(res.body).toContain("This trip has ended");
    expect(res.body).not.toContain("call them now");
  });

  it("uses human status labels, not raw enums", async () => {
    const { ride, token } = await rideWithSosReadyRider();
    const sos = await app.inject({ method: "POST", url: `/rides/${ride.id}/sos`, headers: auth(token) });
    const trackPath = new URL(sos.json().trackingUrl).pathname;

    const res = await app.inject({ method: "GET", url: trackPath });

    expect(res.body).toContain("On the trip");
    expect(res.body).not.toContain("IN_PROGRESS");
  });

  it("404s on an unknown token", async () => {
    const res = await app.inject({ method: "GET", url: "/track/deadbeefdeadbeefdeadbeefdeadbeef" });
    expect(res.statusCode).toBe(404);
  });
});

// ── Driver phone visibility window (24h after completion) ────────────────────

describe("GET /rides/:id — driver phone TTL", () => {
  /** A ride with a driver, completed `hoursAgo` ago (0 = still running). */
  async function rideCompleted(hoursAgo: number | null) {
    const driver = await createTestDriver({ isOnline: true, isApproved: true });
    createdDriverUserIds.push(driver.user.id);

    const { ride, rider } = await createTestRide({
      type: "LONE",
      status: hoursAgo === null ? "IN_PROGRESS" : "COMPLETED",
      driverId: driver.user.id,
    });
    createdRideIds.push(ride.id);

    if (hoursAgo !== null) {
      await prisma.ride.update({
        where: { id: ride.id },
        data: { completedAt: new Date(Date.now() - hoursAgo * 60 * 60 * 1000) },
      });
    }

    return { ride, driver, token: signAccessToken({ userId: rider.id, role: "RIDER" }) };
  }

  it("exposes the driver's phone during the ride", async () => {
    const { ride, driver, token } = await rideCompleted(null);

    const res = await app.inject({ method: "GET", url: `/rides/${ride.id}`, headers: auth(token) });

    expect(res.statusCode).toBe(200);
    expect(res.json().driver.phone).toBe(driver.user.phone);
  });

  it("still exposes it the next morning — the 'I left my bag' case", async () => {
    const { ride, driver, token } = await rideCompleted(12);

    const res = await app.inject({ method: "GET", url: `/rides/${ride.id}`, headers: auth(token) });

    expect(res.json().driver.phone).toBe(driver.user.phone);
  });

  it("withholds it once the ride is more than 24h old", async () => {
    const { ride, token } = await rideCompleted(25);

    const res = await app.inject({ method: "GET", url: `/rides/${ride.id}`, headers: auth(token) });

    expect(res.statusCode).toBe(200);
    // The rest of the driver payload stays — only the number goes.
    expect(res.json().driver.phone).toBeNull();
    expect(res.json().driver.name).toBeTruthy();
  });
});

// ── Rejections clear on re-broadcast ─────────────────────────────────────────

describe("RideRejection lifecycle", () => {
  it("clears a driver's rejection when the ride is re-broadcast", async () => {
    const { pickup, dropoff } = await getTestZones();
    const driver = await authedDriver();
    await prisma.driver.update({
      where: { userId: driver.user.id },
      data: { currentZoneId: pickup.id },
    });

    const { ride } = await createTestRide({
      type: "LONE",
      status: "REQUESTED",
      pickupZoneId: pickup.id,
      dropoffZoneId: dropoff.id,
      broadcastStartedAt: new Date(),
    });
    createdRideIds.push(ride.id);

    await app.inject({
      method: "POST",
      url: `/rides/${ride.id}/reject`,
      headers: auth(driver.token),
    });
    expect(await prisma.rideRejection.count({ where: { rideId: ride.id } })).toBe(1);

    // The dispatch window expires with no claim, the rider keeps waiting, and
    // the ride goes back out to everyone.
    await applyRideTransition(prisma, ride.id, "AWAITING_RIDER_DECISION");
    await riderDecision(prisma, ride.id, "KEEP_WAITING");

    expect(await prisma.rideRejection.count({ where: { rideId: ride.id } })).toBe(0);

    // And the driver who passed sees it offered again.
    const eligible = await app.inject({
      method: "GET",
      url: "/driver/rides/eligible",
      headers: auth(driver.token),
    });
    expect(eligible.json().rides.map((r: { rideId: string }) => r.rideId)).toContain(ride.id);
  });

  it("clears rejections when a SHARED ride is switched to LONE and re-broadcast", async () => {
    const { pickup, dropoff } = await getTestZones();
    const driver = await authedDriver();

    const { ride, rider } = await createTestRide({
      type: "SHARED",
      status: "AWAITING_RIDER_DECISION",
      pickupZoneId: pickup.id,
      dropoffZoneId: dropoff.id,
      decisionStartedAt: new Date(),
    });
    createdRideIds.push(ride.id);
    await prisma.ridePassenger.create({
      data: {
        rideId: ride.id,
        riderId: rider.id,
        pickupZoneId: pickup.id,
        dropoffZoneId: dropoff.id,
        status: "WAITING",
      },
    });
    await prisma.rideRejection.create({
      data: { rideId: ride.id, driverUserId: driver.user.id },
    });

    await riderDecision(prisma, ride.id, "SWITCH_TO_LONE");

    expect(await prisma.rideRejection.count({ where: { rideId: ride.id } })).toBe(0);
  });

  it("keeps the rejection while the ride stays in the same broadcast window", async () => {
    const { ride } = await createTestRide({ type: "LONE", status: "REQUESTED" });
    createdRideIds.push(ride.id);
    const driver = await authedDriver();

    await app.inject({
      method: "POST",
      url: `/rides/${ride.id}/reject`,
      headers: auth(driver.token),
    });

    // Nothing re-broadcasts here, so the decline must stick.
    expect(await prisma.rideRejection.count({ where: { rideId: ride.id } })).toBe(1);
  });
});

// ── Task 8: driver -> rider ratings ───────────────────────────────────────────

describe("POST /ratings/rider", () => {
  async function completedRideWithDriver() {
    const driver = await authedDriver();
    const { ride, rider } = await createTestRide({
      type: "LONE",
      status: "COMPLETED",
      driverId: driver.user.id,
    });
    createdRideIds.push(ride.id);
    return { ride, rider, driver };
  }

  it("lets the driver rate a rider from their completed ride", async () => {
    const { ride, rider, driver } = await completedRideWithDriver();

    const res = await app.inject({
      method: "POST",
      url: "/ratings/rider",
      headers: auth(driver.token),
      payload: { rideId: ride.id, riderId: rider.id, stars: 5, comment: "Polite" },
    });

    expect(res.statusCode).toBe(201);
    const row = await prisma.rating.findFirstOrThrow({
      where: { rideId: ride.id, raterId: driver.user.id, rateeId: rider.id },
    });
    expect(row.stars).toBe(5);
    expect(row.comment).toBe("Polite");
  });

  it("upserts so the driver can correct a rating", async () => {
    const { ride, rider, driver } = await completedRideWithDriver();
    const payload = { rideId: ride.id, riderId: rider.id };

    await app.inject({
      method: "POST",
      url: "/ratings/rider",
      headers: auth(driver.token),
      payload: { ...payload, stars: 2 },
    });
    await app.inject({
      method: "POST",
      url: "/ratings/rider",
      headers: auth(driver.token),
      payload: { ...payload, stars: 4 },
    });

    const rows = await prisma.rating.findMany({ where: { rideId: ride.id, raterId: driver.user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.stars).toBe(4);
  });

  it("rejects a rider who was not on the ride", async () => {
    const { ride, driver } = await completedRideWithDriver();
    const outsider = await authedRider();

    const res = await app.inject({
      method: "POST",
      url: "/ratings/rider",
      headers: auth(driver.token),
      payload: { rideId: ride.id, riderId: outsider.rider.id, stars: 5 },
    });

    expect(res.statusCode).toBe(404);
  });

  it("rejects a driver who did not drive the ride", async () => {
    const { ride, rider } = await completedRideWithDriver();
    const otherDriver = await authedDriver();

    const res = await app.inject({
      method: "POST",
      url: "/ratings/rider",
      headers: auth(otherDriver.token),
      payload: { rideId: ride.id, riderId: rider.id, stars: 5 },
    });

    expect(res.statusCode).toBe(403);
  });

  it("refuses a rider role", async () => {
    const { ride, rider } = await completedRideWithDriver();
    const riderToken = signAccessToken({ userId: rider.id, role: "RIDER" });

    const res = await app.inject({
      method: "POST",
      url: "/ratings/rider",
      headers: auth(riderToken),
      payload: { rideId: ride.id, riderId: rider.id, stars: 5 },
    });

    expect(res.statusCode).toBe(403);
  });

  it("refuses before the ride is completed", async () => {
    const driver = await authedDriver();
    const { ride, rider } = await createTestRide({
      type: "LONE",
      status: "IN_PROGRESS",
      driverId: driver.user.id,
    });
    createdRideIds.push(ride.id);

    const res = await app.inject({
      method: "POST",
      url: "/ratings/rider",
      headers: auth(driver.token),
      payload: { rideId: ride.id, riderId: rider.id, stars: 5 },
    });

    expect(res.statusCode).toBe(409);
  });

  it("validates the star range", async () => {
    const { ride, rider, driver } = await completedRideWithDriver();
    for (const stars of [0, 6, 2.5, "5"]) {
      const res = await app.inject({
        method: "POST",
        url: "/ratings/rider",
        headers: auth(driver.token),
        payload: { rideId: ride.id, riderId: rider.id, stars },
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it("GET /rides/:id/rateable-riders lists the riders and any existing stars", async () => {
    const { ride, rider, driver } = await completedRideWithDriver();

    const before = await app.inject({
      method: "GET",
      url: `/rides/${ride.id}/rateable-riders`,
      headers: auth(driver.token),
    });
    expect(before.statusCode).toBe(200);
    expect(before.json().riders).toEqual([{ riderId: rider.id, name: expect.any(String), stars: null }]);

    await app.inject({
      method: "POST",
      url: "/ratings/rider",
      headers: auth(driver.token),
      payload: { rideId: ride.id, riderId: rider.id, stars: 3 },
    });

    const after = await app.inject({
      method: "GET",
      url: `/rides/${ride.id}/rateable-riders`,
      headers: auth(driver.token),
    });
    expect(after.json().riders[0].stars).toBe(3);
  });
});

// ── Task 9: explicit driver reject ────────────────────────────────────────────

describe("POST /rides/:id/reject", () => {
  it("records the rejection and hides the ride from that driver only", async () => {
    const { pickup, dropoff } = await getTestZones();
    const rejecting = await authedDriver();
    const other = await authedDriver();
    await prisma.driver.updateMany({
      where: { userId: { in: [rejecting.user.id, other.user.id] } },
      data: { currentZoneId: pickup.id },
    });

    const { ride } = await createTestRide({
      type: "LONE",
      status: "REQUESTED",
      pickupZoneId: pickup.id,
      dropoffZoneId: dropoff.id,
      broadcastStartedAt: new Date(),
    });
    createdRideIds.push(ride.id);

    const res = await app.inject({
      method: "POST",
      url: `/rides/${ride.id}/reject`,
      headers: auth(rejecting.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ rejected: true, rideId: ride.id });

    const mine = await app.inject({
      method: "GET",
      url: "/driver/rides/eligible",
      headers: auth(rejecting.token),
    });
    expect(mine.json().rides.map((r: { rideId: string }) => r.rideId)).not.toContain(ride.id);

    // Still offered to everyone else — a reject is not a cancel.
    const theirs = await app.inject({
      method: "GET",
      url: "/driver/rides/eligible",
      headers: auth(other.token),
    });
    expect(theirs.json().rides.map((r: { rideId: string }) => r.rideId)).toContain(ride.id);
  });

  it("is idempotent", async () => {
    const { ride } = await createTestRide({ type: "LONE", status: "REQUESTED" });
    createdRideIds.push(ride.id);
    const driver = await authedDriver();

    const first = await app.inject({
      method: "POST",
      url: `/rides/${ride.id}/reject`,
      headers: auth(driver.token),
    });
    const second = await app.inject({
      method: "POST",
      url: `/rides/${ride.id}/reject`,
      headers: auth(driver.token),
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const rows = await prisma.rideRejection.findMany({ where: { rideId: ride.id } });
    expect(rows).toHaveLength(1);
  });

  it("does not change the ride itself", async () => {
    const { ride } = await createTestRide({ type: "LONE", status: "REQUESTED" });
    createdRideIds.push(ride.id);
    const driver = await authedDriver();

    await app.inject({ method: "POST", url: `/rides/${ride.id}/reject`, headers: auth(driver.token) });

    const after = await prisma.ride.findUniqueOrThrow({ where: { id: ride.id } });
    expect(after.status).toBe("REQUESTED");
    expect(after.driverId).toBeNull();
  });

  it("refuses once the ride is claimed", async () => {
    const claimer = await authedDriver();
    const { ride } = await createTestRide({
      type: "LONE",
      status: "MATCHED",
      driverId: claimer.user.id,
    });
    createdRideIds.push(ride.id);
    const other = await authedDriver();

    const res = await app.inject({
      method: "POST",
      url: `/rides/${ride.id}/reject`,
      headers: auth(other.token),
    });
    expect(res.statusCode).toBe(409);
  });

  it("refuses a rider role and 404s an unknown ride", async () => {
    const rider = await authedRider();
    const driver = await authedDriver();

    expect(
      (await app.inject({ method: "POST", url: "/rides/x/reject", headers: auth(rider.token) }))
        .statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: "POST", url: "/rides/nope/reject", headers: auth(driver.token) }))
        .statusCode,
    ).toBe(404);
  });
});

// ── Task 5: earnings breakdown ────────────────────────────────────────────────

describe("GET /driver/rides/history — commission and net", () => {
  it("reports gross, commission owed and net for CASH rides", async () => {
    const driver = await authedDriver();
    const { ride } = await createTestRide({
      type: "LONE",
      status: "COMPLETED",
      driverId: driver.user.id,
    });
    createdRideIds.push(ride.id);

    const { commission } = splitFare(getLoneFare());
    await prisma.commissionLedger.create({
      data: { driverUserId: driver.user.id, rideId: ride.id, amountPesewas: commission },
    });

    const res = await app.inject({
      method: "GET",
      url: "/driver/rides/history",
      headers: auth(driver.token),
    });

    expect(res.statusCode).toBe(200);
    const { summary } = res.json();
    expect(summary.totalRides).toBe(1);
    expect(summary.commissionOwedPesewas).toBe(commission);
    expect(summary.commissionRidesCount).toBe(1);
    expect(summary.netPesewas).toBe(summary.totalGrossPesewas - commission);
  });

  it("reports zero commission when the driver has no ledger rows", async () => {
    const driver = await authedDriver();
    const { ride } = await createTestRide({
      type: "LONE",
      status: "COMPLETED",
      driverId: driver.user.id,
    });
    createdRideIds.push(ride.id);

    const res = await app.inject({
      method: "GET",
      url: "/driver/rides/history",
      headers: auth(driver.token),
    });

    const { summary } = res.json();
    expect(summary.commissionOwedPesewas).toBe(0);
    // With nothing owed, net is exactly gross.
    expect(summary.netPesewas).toBe(summary.totalGrossPesewas);
  });
});

// ── Task 7: ride history pagination ───────────────────────────────────────────

describe("GET /rides/mine — pagination", () => {
  /** Creates `count` rides for one rider, oldest first. */
  async function ridesForRider(count: number) {
    const { pickup, dropoff } = await getTestZones();
    const rider = await createTestUser("RIDER");
    multiRideRiderIds.push(rider.id);

    for (let i = 0; i < count; i++) {
      await prisma.ride.create({
        data: {
          riderId: rider.id,
          type: "LONE",
          status: "COMPLETED",
          pickupZoneId: pickup.id,
          dropoffZoneId: dropoff.id,
          occupancy: 1,
          createdAt: new Date(Date.now() - (count - i) * 60_000),
        },
      });
    }
    return { rider, token: signAccessToken({ userId: rider.id, role: "RIDER" }) };
  }

  it("returns a page plus a cursor, and walks the whole history", async () => {
    const { token } = await ridesForRider(7);

    const first = await app.inject({
      method: "GET",
      url: "/rides/mine?limit=3",
      headers: auth(token),
    });
    expect(first.statusCode).toBe(200);
    const page1 = first.json();
    expect(page1.rides).toHaveLength(3);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBe(page1.rides[2].id);

    const second = await app.inject({
      method: "GET",
      url: `/rides/mine?limit=3&cursor=${page1.nextCursor}`,
      headers: auth(token),
    });
    const page2 = second.json();
    expect(page2.rides).toHaveLength(3);

    const third = await app.inject({
      method: "GET",
      url: `/rides/mine?limit=3&cursor=${page2.nextCursor}`,
      headers: auth(token),
    });
    const page3 = third.json();
    expect(page3.rides).toHaveLength(1);
    expect(page3.hasMore).toBe(false);
    expect(page3.nextCursor).toBeNull();

    // No duplicates and no gaps across the three pages.
    const ids = [...page1.rides, ...page2.rides, ...page3.rides].map((r: { id: string }) => r.id);
    expect(new Set(ids).size).toBe(7);
  });

  it("orders newest first", async () => {
    const { token } = await ridesForRider(3);
    const res = await app.inject({ method: "GET", url: "/rides/mine", headers: auth(token) });
    const dates = res.json().rides.map((r: { createdAt: string }) => new Date(r.createdAt).getTime());
    expect(dates).toEqual([...dates].sort((a, b) => b - a));
  });

  it("caps an oversized limit and ignores a junk one", async () => {
    const { token } = await ridesForRider(2);

    const huge = await app.inject({
      method: "GET",
      url: "/rides/mine?limit=9999",
      headers: auth(token),
    });
    expect(huge.statusCode).toBe(200);
    expect(huge.json().rides.length).toBeLessThanOrEqual(50);

    const junk = await app.inject({
      method: "GET",
      url: "/rides/mine?limit=abc",
      headers: auth(token),
    });
    expect(junk.statusCode).toBe(200);
    expect(junk.json().rides).toHaveLength(2);
  });

  it("only ever returns the caller's own rides", async () => {
    const mine = await ridesForRider(2);
    await ridesForRider(2);

    const res = await app.inject({ method: "GET", url: "/rides/mine", headers: auth(mine.token) });
    expect(res.json().rides).toHaveLength(2);
    for (const ride of res.json().rides) {
      expect(ride.riderId).toBe(mine.rider.id);
    }
  });
});

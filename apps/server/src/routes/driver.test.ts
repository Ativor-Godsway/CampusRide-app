import { describe, it, expect, vi, afterEach, afterAll, beforeAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { prisma } from "../db/prisma";
import { registerDriverRoutes } from "./driver";
import { signAccessToken } from "../services/auth/tokens";
import { createTestDriver, createTestRide, cleanupDriver, cleanupRide } from "../services/ride/testFixtures";

vi.mock("../services/sms/sendSms", () => ({
  sendSms: vi.fn().mockResolvedValue({ success: true }),
}));
import { sendSms } from "../services/sms/sendSms";

let app: FastifyInstance;
const createdDriverUserIds: string[] = [];
const createdRideIds: string[] = [];

beforeAll(async () => {
  app = Fastify();
  registerDriverRoutes(app, prisma);
  await app.ready();
});

afterEach(async () => {
  vi.mocked(sendSms).mockClear();
  while (createdRideIds.length > 0) {
    await cleanupRide(createdRideIds.pop()!);
  }
  while (createdDriverUserIds.length > 0) {
    await cleanupDriver(createdDriverUserIds.pop()!);
  }
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

async function authedDriver() {
  const { user, driver } = await createTestDriver({ isOnline: true, isApproved: true });
  createdDriverUserIds.push(user.id);
  const token = signAccessToken({ userId: user.id, role: "DRIVER" });
  return { user, driver, token };
}

/**
 * Every hook fires via `void notifyUssdRider(...)` (fire-and-forget, never
 * awaited by the route — same convention as broadcastRide) so it lands some
 * microtasks after app.inject() resolves. Poll instead of asserting
 * immediately, or the assertion races the in-flight DB lookup + sendSms call.
 */
async function waitForSms(): Promise<void> {
  await vi.waitFor(() => {
    expect(sendSms).toHaveBeenCalledTimes(1);
  }, { timeout: 2000 });
}

/**
 * Checkpoint 5 explicit requirement: app riders must get ZERO SMS (still
 * push only), USSD-origin riders must get exactly the documented message on
 * each transition, and no transition route can be broken by sendSms being
 * mocked/failing. Verified end-to-end via Fastify injection, not just by
 * reading the source — `sendSms` is mocked so no real Moolre call happens
 * regardless of MOOLRE_ENABLED.
 */
describe("USSD SMS hooks on driver-triggered transitions", () => {
  it("claim: sends 'Driver matched!' for a USSD ride, nothing for an APP ride", async () => {
    const { token: ussdToken } = await authedDriver();
    const ussdRide = await createTestRide({ type: "LONE", status: "REQUESTED", source: "USSD" });
    createdRideIds.push(ussdRide.ride.id);

    const ussdRes = await app.inject({
      method: "POST",
      url: `/rides/${ussdRide.ride.id}/claim`,
      headers: { authorization: `Bearer ${ussdToken}` },
    });
    expect(ussdRes.statusCode).toBe(200);
    await waitForSms();
    expect(vi.mocked(sendSms).mock.calls[0]![1]).toBe("Driver matched! They're on the way.");

    vi.mocked(sendSms).mockClear();

    const { token: appToken } = await authedDriver();
    const appRide = await createTestRide({ type: "LONE", status: "REQUESTED" });
    createdRideIds.push(appRide.ride.id);

    const appRes = await app.inject({
      method: "POST",
      url: `/rides/${appRide.ride.id}/claim`,
      headers: { authorization: `Bearer ${appToken}` },
    });
    expect(appRes.statusCode).toBe(200);
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("ride-level arrived: sends 'Your driver has arrived' for USSD only", async () => {
    const { user: ussdDriver, token: ussdToken } = await authedDriver();
    const ussdRide = await createTestRide({ type: "LONE", status: "MATCHED", driverId: ussdDriver.id, source: "USSD" });
    createdRideIds.push(ussdRide.ride.id);

    const ussdRes = await app.inject({
      method: "POST",
      url: `/rides/${ussdRide.ride.id}/arrived`,
      headers: { authorization: `Bearer ${ussdToken}` },
    });
    expect(ussdRes.statusCode).toBe(200);
    await waitForSms();
    expect(vi.mocked(sendSms).mock.calls[0]![1]).toBe("Your driver has arrived.");

    vi.mocked(sendSms).mockClear();

    const { user: appDriver, token: appToken } = await authedDriver();
    const appRide = await createTestRide({ type: "LONE", status: "MATCHED", driverId: appDriver.id });
    createdRideIds.push(appRide.ride.id);

    const appRes = await app.inject({
      method: "POST",
      url: `/rides/${appRide.ride.id}/arrived`,
      headers: { authorization: `Bearer ${appToken}` },
    });
    expect(appRes.statusCode).toBe(200);
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("ride-level complete (LONE): sends 'Trip complete' for USSD only", async () => {
    const { user: ussdDriver, token: ussdToken } = await authedDriver();
    const { ride: ussdRide } = await createTestRide({
      type: "LONE",
      status: "IN_PROGRESS",
      driverId: ussdDriver.id,
      source: "USSD",
    });
    createdRideIds.push(ussdRide.id);
    await prisma.ridePassenger.create({
      data: {
        rideId: ussdRide.id,
        riderId: ussdRide.riderId,
        pickupZoneId: ussdRide.pickupZoneId,
        dropoffZoneId: ussdRide.dropoffZoneId,
        status: "PICKED_UP",
        lockedFare: 1500,
      },
    });

    const ussdRes = await app.inject({
      method: "POST",
      url: `/rides/${ussdRide.id}/complete`,
      headers: { authorization: `Bearer ${ussdToken}` },
    });
    expect(ussdRes.statusCode).toBe(200);
    await waitForSms();
    expect(vi.mocked(sendSms).mock.calls[0]![1]).toBe("Trip complete. Thanks for riding CampusRide.");

    vi.mocked(sendSms).mockClear();

    const { user: appDriver, token: appToken } = await authedDriver();
    const { ride: appRide } = await createTestRide({ type: "LONE", status: "IN_PROGRESS", driverId: appDriver.id });
    createdRideIds.push(appRide.id);
    await prisma.ridePassenger.create({
      data: {
        rideId: appRide.id,
        riderId: appRide.riderId,
        pickupZoneId: appRide.pickupZoneId,
        dropoffZoneId: appRide.dropoffZoneId,
        status: "PICKED_UP",
        lockedFare: 1500,
      },
    });

    const appRes = await app.inject({
      method: "POST",
      url: `/rides/${appRide.id}/complete`,
      headers: { authorization: `Bearer ${appToken}` },
    });
    expect(appRes.statusCode).toBe(200);
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("per-passenger arrived (SHARED): sends 'Your driver has arrived' for USSD only", async () => {
    const { user: ussdDriver, token: ussdToken } = await authedDriver();
    const { ride: ussdRide } = await createTestRide({
      type: "SHARED",
      status: "MATCHED",
      driverId: ussdDriver.id,
      source: "USSD",
    });
    createdRideIds.push(ussdRide.id);
    const passenger = await prisma.ridePassenger.create({
      data: {
        rideId: ussdRide.id,
        riderId: ussdRide.riderId,
        pickupZoneId: ussdRide.pickupZoneId,
        dropoffZoneId: ussdRide.dropoffZoneId,
        status: "WAITING",
        lockedFare: 500,
      },
    });

    const ussdRes = await app.inject({
      method: "POST",
      url: `/rides/${ussdRide.id}/passengers/${passenger.id}/arrived`,
      headers: { authorization: `Bearer ${ussdToken}` },
    });
    expect(ussdRes.statusCode).toBe(200);
    await waitForSms();
    expect(vi.mocked(sendSms).mock.calls[0]![1]).toBe("Your driver has arrived.");

    vi.mocked(sendSms).mockClear();

    const { user: appDriver, token: appToken } = await authedDriver();
    const { ride: appRide } = await createTestRide({ type: "SHARED", status: "MATCHED", driverId: appDriver.id });
    createdRideIds.push(appRide.id);
    const appPassenger = await prisma.ridePassenger.create({
      data: {
        rideId: appRide.id,
        riderId: appRide.riderId,
        pickupZoneId: appRide.pickupZoneId,
        dropoffZoneId: appRide.dropoffZoneId,
        status: "WAITING",
        lockedFare: 500,
      },
    });

    const appRes = await app.inject({
      method: "POST",
      url: `/rides/${appRide.id}/passengers/${appPassenger.id}/arrived`,
      headers: { authorization: `Bearer ${appToken}` },
    });
    expect(appRes.statusCode).toBe(200);
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("per-passenger dropoff auto-complete (SHARED, last passenger): sends 'Trip complete' for USSD only", async () => {
    const { user: ussdDriver, token: ussdToken } = await authedDriver();
    const { ride: ussdRide } = await createTestRide({
      type: "SHARED",
      status: "IN_PROGRESS",
      driverId: ussdDriver.id,
      source: "USSD",
    });
    createdRideIds.push(ussdRide.id);
    const passenger = await prisma.ridePassenger.create({
      data: {
        rideId: ussdRide.id,
        riderId: ussdRide.riderId,
        pickupZoneId: ussdRide.pickupZoneId,
        dropoffZoneId: ussdRide.dropoffZoneId,
        status: "PICKED_UP",
        lockedFare: 500,
      },
    });

    const ussdRes = await app.inject({
      method: "POST",
      url: `/rides/${ussdRide.id}/passengers/${passenger.id}/dropoff`,
      headers: { authorization: `Bearer ${ussdToken}` },
    });
    expect(ussdRes.statusCode).toBe(200);
    expect(ussdRes.json().ride.status).toBe("COMPLETED");
    await waitForSms();
    expect(vi.mocked(sendSms).mock.calls[0]![1]).toBe("Trip complete. Thanks for riding CampusRide.");

    vi.mocked(sendSms).mockClear();

    const { user: appDriver, token: appToken } = await authedDriver();
    const { ride: appRide } = await createTestRide({ type: "SHARED", status: "IN_PROGRESS", driverId: appDriver.id });
    createdRideIds.push(appRide.id);
    const appPassenger = await prisma.ridePassenger.create({
      data: {
        rideId: appRide.id,
        riderId: appRide.riderId,
        pickupZoneId: appRide.pickupZoneId,
        dropoffZoneId: appRide.dropoffZoneId,
        status: "PICKED_UP",
        lockedFare: 500,
      },
    });

    const appRes = await app.inject({
      method: "POST",
      url: `/rides/${appRide.id}/passengers/${appPassenger.id}/dropoff`,
      headers: { authorization: `Bearer ${appToken}` },
    });
    expect(appRes.statusCode).toBe(200);
    expect(appRes.json().ride.status).toBe("COMPLETED");
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("never breaks the transition route even if sendSms rejects", async () => {
    vi.mocked(sendSms).mockRejectedValueOnce(new Error("Moolre is down"));

    const { token } = await authedDriver();
    const { ride } = await createTestRide({ type: "LONE", status: "REQUESTED", source: "USSD" });
    createdRideIds.push(ride.id);

    const res = await app.inject({
      method: "POST",
      url: `/rides/${ride.id}/claim`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ride.status).toBe("MATCHED");

    // Let the rejected fire-and-forget call settle before the suite moves on,
    // so it can't be mistaken for a later test's call.
    await vi.waitFor(() => {
      expect(sendSms).toHaveBeenCalledTimes(1);
    }, { timeout: 2000 });
  });
});

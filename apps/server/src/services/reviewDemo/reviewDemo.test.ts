/**
 * The App Store / Google Play review demo (services/reviewDemo): only the two
 * configured numbers get the fixed code (and no SMS), only while the switch
 * is on; their rides are served by simulated people and kept apart from real
 * riders, drivers and the admin site.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { prisma } from "../../db/prisma";
import { registerAllRoutes } from "../../routes";
import { DummyPaymentService } from "../payment/DummyPaymentService";
import { CapturingOtpService } from "../auth/testFixtures";
import { signAccessToken } from "../auth/tokens";
import { uniqueGhanaPhone } from "../../test/testPhone";
import { setRateLimitStore } from "../../rateLimit/limiter";
import { MemoryRateLimitStore } from "../../rateLimit/store";
import { RULES } from "../../rateLimit/rules";
import { createTestDriver, getTestZones } from "../ride/testFixtures";
import { claimIfOpen, getEligibleDrivers } from "../ride/dispatch";
import { resolveReviewDemo, setReviewDemoConfigForTests, type ReviewDemoConfig } from "./config";
import { ensureDemoAccount, SIM_DRIVER_PHONE, SIM_RIDER_PHONE } from "./accounts";
import { demoRequestTick, resetDemoRequestClock, setDemoTimingForTests } from "./simulation";

const OTP = "246913";
let app: FastifyInstance;
const otp = new CapturingOtpService();
const riderPhone = uniqueGhanaPhone();
const driverPhone = uniqueGhanaPhone();
const userIds: string[] = [];

const on = (): ReviewDemoConfig => ({
  enabled: true,
  riderPhone,
  driverPhone,
  otp: OTP,
  problems: [],
});
const off: ReviewDemoConfig = {
  enabled: false,
  riderPhone: null,
  driverPhone: null,
  otp: null,
  problems: [],
};

beforeAll(async () => {
  app = Fastify();
  registerAllRoutes(app, prisma, { otpService: otp, paymentService: new DummyPaymentService() });
  await app.ready();
  setDemoTimingForTests({
    claimDelayMs: 10,
    stepMs: 5,
    approachSteps: 3,
    waitAtPickupMs: 10,
    tripSteps: 3,
    requestEveryMs: 0,
    requestExpireMs: 50,
    tickMs: 1_000,
  });
});

beforeEach(() => {
  setReviewDemoConfigForTests(on());
  setRateLimitStore(new MemoryRateLimitStore(10_000, 0));
});

afterEach(() => {
  setReviewDemoConfigForTests(null);
});

afterAll(async () => {
  setDemoTimingForTests(null);
  const demo = await prisma.user.findMany({
    where: {
      OR: [
        { phone: { in: [riderPhone, driverPhone, SIM_DRIVER_PHONE, SIM_RIDER_PHONE] } },
        { id: { in: userIds } },
      ],
    },
    select: { id: true },
  });
  const ids = demo.map((u) => u.id);
  await prisma.ride.deleteMany({
    where: { OR: [{ riderId: { in: ids } }, { driverId: { in: ids } }] },
  });
  await prisma.otpCode.deleteMany({ where: { phone: { in: [riderPhone, driverPhone] } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await app.close();
});

const post = (url: string, payload: object, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url, payload, headers });
const auth = (userId: string, role: "RIDER" | "DRIVER" | "ADMIN") => ({
  authorization: `Bearer ${signAccessToken({ userId, role })}`,
});

async function signInWithCode(phone: string, code: string) {
  const sent = await post("/auth/request-otp", { phone, purpose: "LOGIN" });
  const verified = await post("/auth/verify-otp", { phone, code, purpose: "LOGIN" });
  return { sent, verified };
}

describe("settings and the kill switch", () => {
  const env = {
    REVIEW_DEMO_RIDER_PHONE: "0240000001",
    REVIEW_DEMO_DRIVER_PHONE: "0240000002",
    REVIEW_DEMO_OTP: "123987",
  };

  it("is off unless REVIEW_DEMO_ENABLED=true", () => {
    expect(resolveReviewDemo(env).enabled).toBe(false);
    expect(resolveReviewDemo({ ...env, REVIEW_DEMO_ENABLED: "false" }).enabled).toBe(false);
    expect(resolveReviewDemo({ ...env, REVIEW_DEMO_ENABLED: "true" })).toMatchObject({
      enabled: true,
      riderPhone: "+233240000001",
      driverPhone: "+233240000002",
    });
  });

  it("stays off, naming the problem but never a value, when a setting is wrong", () => {
    const bad = [
      { REVIEW_DEMO_RIDER_PHONE: "12345" },
      { REVIEW_DEMO_DRIVER_PHONE: env.REVIEW_DEMO_RIDER_PHONE },
      { REVIEW_DEMO_OTP: "12345" },
      { REVIEW_DEMO_OTP: "abcdef" },
    ];
    for (const change of bad) {
      const result = resolveReviewDemo({ ...env, ...change, REVIEW_DEMO_ENABLED: "true" });
      expect(result.enabled).toBe(false);
      expect(result.problems.length).toBeGreaterThan(0);
      expect(JSON.stringify(result.problems)).not.toContain("123987");
    }
    expect(
      resolveReviewDemo({ ...env, REVIEW_DEMO_ENABLED: "true" }, ["+233240000001"]).enabled,
    ).toBe(false);
  });
});

describe("signing in", () => {
  it("a review number gets the fixed code and no SMS", async () => {
    const { sent, verified } = await signInWithCode(riderPhone, OTP);
    expect(sent.statusCode).toBe(200);
    expect(verified.statusCode).toBe(200);
    expect(() => otp.codeFor(riderPhone)).toThrow();
    const login = await post("/auth/login", {
      phone: riderPhone,
      verifiedToken: verified.json().verifiedToken,
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().user).toMatchObject({ role: "RIDER", isReviewDemo: true });

    // The driver account is ready too: approved, no sign-up or car details needed.
    const driver = await signInWithCode(driverPhone, OTP);
    const driverLogin = await post("/auth/login", {
      phone: driverPhone,
      verifiedToken: driver.verified.json().verifiedToken,
    });
    expect(driverLogin.json().user).toMatchObject({
      role: "DRIVER",
      isReviewDemo: true,
      driver: { isApproved: true },
    });
  });

  it("any other number can't use the fixed code, and gets its SMS as usual", async () => {
    const phone = uniqueGhanaPhone();
    await post("/auth/request-otp", { phone, purpose: "SIGNUP" });
    expect(otp.codeFor(phone)).toMatch(/^\d{6}$/);
    expect(otp.codeFor(phone)).not.toBe(OTP);
    const wrong = await post("/auth/verify-otp", { phone, code: OTP, purpose: "SIGNUP" });
    expect(wrong.statusCode).toBe(400);
    await prisma.otpCode.deleteMany({ where: { phone } });
  });

  it("switched off, a review number is an ordinary number: SMS sent, fixed code refused", async () => {
    setReviewDemoConfigForTests(off);
    const { sent, verified } = await signInWithCode(riderPhone, OTP);
    expect(sent.statusCode).toBe(200);
    expect(otp.codeFor(riderPhone)).not.toBe(OTP);
    expect(verified.statusCode).toBe(400);
  });

  it("keeps the per-number limits", async () => {
    // One code per cooldown per number, demo or not (looser under tests, never in production).
    for (let i = 0; i < RULES.otpCooldown.max; i++) {
      expect(
        (await post("/auth/request-otp", { phone: driverPhone, purpose: "LOGIN" })).statusCode,
      ).toBe(200);
    }
    expect(
      (await post("/auth/request-otp", { phone: driverPhone, purpose: "LOGIN" })).statusCode,
    ).toBe(429);
  });

  it("never takes over a real account that has the number", async () => {
    const phone = uniqueGhanaPhone();
    const real = await prisma.user.create({ data: { phone, name: "Real Person", role: "RIDER" } });
    userIds.push(real.id);
    setReviewDemoConfigForTests({ ...on(), riderPhone: phone });
    await post("/auth/request-otp", { phone, purpose: "LOGIN" });
    expect(otp.codeFor(phone)).not.toBe(OTP);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: real.id } })).isReviewDemo).toBe(
      false,
    );
    await prisma.otpCode.deleteMany({ where: { phone } });
  });
});

describe("kept apart from real people", () => {
  it("a real ride never reaches a demo driver, a demo ride never a real one", async () => {
    const { pickup } = await getTestZones();
    const demoDriverId = (await ensureDemoAccount(prisma, "driver"))!;
    await prisma.driver.update({
      where: { userId: demoDriverId },
      data: { isOnline: true, currentZoneId: pickup.id },
    });
    const { user: realDriver } = await createTestDriver({
      isOnline: true,
      currentZoneId: pickup.id,
    });
    userIds.push(realDriver.id);

    const forReal = (
      await getEligibleDrivers(prisma, { pickupZoneId: pickup.id, isReviewDemo: false })
    ).map((d) => d.userId);
    const forDemo = (
      await getEligibleDrivers(prisma, { pickupZoneId: pickup.id, isReviewDemo: true })
    ).map((d) => d.userId);
    expect(forReal).toContain(realDriver.id);
    expect(forReal).not.toContain(demoDriverId);
    expect(forDemo).toEqual([demoDriverId]);
    await prisma.driver.update({ where: { userId: demoDriverId }, data: { isOnline: false } });
  });

  it("neither kind of driver can take the other kind of ride", async () => {
    const { pickup, dropoff } = await getTestZones();
    const demoDriverId = (await ensureDemoAccount(prisma, "driver"))!;
    const simRiderId = (await ensureDemoAccount(prisma, "simRider"))!;
    const { user: realDriver } = await createTestDriver();
    const realRider = await prisma.user.create({
      data: { phone: uniqueGhanaPhone(), name: "Real Rider", role: "RIDER" },
    });
    userIds.push(realDriver.id, realRider.id);
    const base = {
      type: "LONE" as const,
      status: "REQUESTED" as const,
      pickupZoneId: pickup.id,
      dropoffZoneId: dropoff.id,
    };
    const demoRide = await prisma.ride.create({
      data: { ...base, riderId: simRiderId, isReviewDemo: true },
    });
    const realRide = await prisma.ride.create({ data: { ...base, riderId: realRider.id } });

    expect(await claimIfOpen(prisma, demoRide.id, realDriver.id)).toBeNull();
    expect(await claimIfOpen(prisma, realRide.id, demoDriverId)).toBeNull();
    expect(await claimIfOpen(prisma, demoRide.id, demoDriverId)).not.toBeNull();
    await prisma.ride.deleteMany({ where: { id: { in: [demoRide.id, realRide.id] } } });
  });

  it("demo rides aren't in the admin site's ride list", async () => {
    const { pickup, dropoff } = await getTestZones();
    const simRiderId = (await ensureDemoAccount(prisma, "simRider"))!;
    const demoRide = await prisma.ride.create({
      data: {
        type: "LONE",
        status: "CANCELLED",
        pickupZoneId: pickup.id,
        dropoffZoneId: dropoff.id,
        riderId: simRiderId,
        isReviewDemo: true,
      },
    });
    const admin = await prisma.user.create({
      data: { phone: uniqueGhanaPhone(), name: "Admin", role: "ADMIN" },
    });
    userIds.push(admin.id);
    const res = await app.inject({
      method: "GET",
      url: "/admin/rides?limit=200",
      headers: auth(admin.id, "ADMIN"),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json().rides as Array<{ id: string }>).map((r) => r.id)).not.toContain(demoRide.id);
    await prisma.ride.delete({ where: { id: demoRide.id } });
  });
});

describe("the simulated people", () => {
  it("the demo rider's request is accepted, driven, started and completed by the simulated driver", async () => {
    const { pickup, dropoff } = await getTestZones();
    const riderId = (await ensureDemoAccount(prisma, "rider"))!;
    const res = await post(
      "/rides",
      { type: "LONE", pickupZoneId: pickup.id, dropoffZoneId: dropoff.id },
      auth(riderId, "RIDER"),
    );
    expect(res.statusCode).toBe(201);
    const rideId = res.json().ride.id as string;

    await vi.waitFor(
      async () => {
        const ride = await prisma.ride.findUniqueOrThrow({
          where: { id: rideId },
          include: { passengers: true },
        });
        expect(ride.status).toBe("COMPLETED");
      },
      { timeout: 10_000, interval: 50 },
    );
    const ride = await prisma.ride.findUniqueOrThrow({
      where: { id: rideId },
      include: { passengers: true, driver: true },
    });
    expect(ride.isReviewDemo).toBe(true);
    expect(ride.driver?.phone).toBe(SIM_DRIVER_PHONE);
    expect(ride.passengers[0]).toMatchObject({ status: "DROPPED_OFF" });
  });

  it("stops when the demo rider cancels", async () => {
    setDemoTimingForTests({
      claimDelayMs: 10,
      stepMs: 200,
      approachSteps: 20,
      waitAtPickupMs: 10,
      tripSteps: 3,
      requestEveryMs: 0,
      requestExpireMs: 50,
      tickMs: 1_000,
    });
    const { pickup, dropoff } = await getTestZones();
    const riderId = (await ensureDemoAccount(prisma, "rider"))!;
    const res = await post(
      "/rides",
      { type: "LONE", pickupZoneId: pickup.id, dropoffZoneId: dropoff.id },
      auth(riderId, "RIDER"),
    );
    const rideId = res.json().ride.id as string;
    await vi.waitFor(
      async () =>
        expect((await prisma.ride.findUniqueOrThrow({ where: { id: rideId } })).status).toBe(
          "MATCHED",
        ),
      {
        timeout: 5_000,
        interval: 20,
      },
    );
    expect(
      (await post(`/rides/${rideId}/cancel`, { reason: null }, auth(riderId, "RIDER"))).statusCode,
    ).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect((await prisma.ride.findUniqueOrThrow({ where: { id: rideId } })).status).toBe(
      "CANCELLED",
    );
    setDemoTimingForTests({
      claimDelayMs: 10,
      stepMs: 5,
      approachSteps: 3,
      waitAtPickupMs: 10,
      tripSteps: 3,
      requestEveryMs: 0,
      requestExpireMs: 50,
      tickMs: 1_000,
    });
  });

  it("the demo driver, online, gets simulated requests that only demo drivers see, and can run the trip", async () => {
    const { pickup } = await getTestZones();
    const driverId = (await ensureDemoAccount(prisma, "driver"))!;
    await prisma.driver.update({
      where: { userId: driverId },
      data: { isOnline: true, currentZoneId: pickup.id },
    });
    const { user: realDriver } = await createTestDriver({
      isOnline: true,
      currentZoneId: pickup.id,
    });
    userIds.push(realDriver.id);
    resetDemoRequestClock();

    await demoRequestTick(prisma);
    const simRiderId = (await ensureDemoAccount(prisma, "simRider"))!;
    const request = await prisma.ride.findFirstOrThrow({
      where: { riderId: simRiderId, status: "REQUESTED" },
      orderBy: { createdAt: "desc" },
    });
    expect(request.isReviewDemo).toBe(true);

    const seenByReal = await app.inject({
      method: "GET",
      url: "/driver/rides/eligible",
      headers: auth(realDriver.id, "DRIVER"),
    });
    expect(
      (seenByReal.json().rides as Array<{ rideId: string }>).map((r) => r.rideId),
    ).not.toContain(request.id);
    const seenByDemo = await app.inject({
      method: "GET",
      url: "/driver/rides/eligible",
      headers: auth(driverId, "DRIVER"),
    });
    expect((seenByDemo.json().rides as Array<{ rideId: string }>).map((r) => r.rideId)).toContain(
      request.id,
    );

    expect(
      (await post(`/rides/${request.id}/claim`, {}, auth(realDriver.id, "DRIVER"))).statusCode,
    ).toBe(409);
    expect(
      (await post(`/rides/${request.id}/claim`, {}, auth(driverId, "DRIVER"))).statusCode,
    ).toBe(200);
    const seat = await prisma.ridePassenger.findFirstOrThrow({ where: { rideId: request.id } });
    for (const action of ["arrived", "pickup", "dropoff"]) {
      const step = await post(
        `/rides/${request.id}/passengers/${seat.id}/${action}`,
        {},
        auth(driverId, "DRIVER"),
      );
      expect(step.statusCode, action).toBe(200);
    }
    expect((await prisma.ride.findUniqueOrThrow({ where: { id: request.id } })).status).toBe(
      "COMPLETED",
    );
    await prisma.driver.update({ where: { userId: driverId }, data: { isOnline: false } });
  });

  it("withdraws an unanswered request, and makes none when the demo is off", async () => {
    const { pickup } = await getTestZones();
    const driverId = (await ensureDemoAccount(prisma, "driver"))!;
    await prisma.driver.update({
      where: { userId: driverId },
      data: { isOnline: true, currentZoneId: pickup.id },
    });
    const simRiderId = (await ensureDemoAccount(prisma, "simRider"))!;
    resetDemoRequestClock();
    await demoRequestTick(prisma);
    const first = await prisma.ride.findFirstOrThrow({
      where: { riderId: simRiderId, status: "REQUESTED" },
    });
    await demoRequestTick(prisma, Date.now() + 60_000);
    expect((await prisma.ride.findUniqueOrThrow({ where: { id: first.id } })).status).toBe(
      "CANCELLED",
    );

    setReviewDemoConfigForTests(off);
    resetDemoRequestClock();
    await demoRequestTick(prisma);
    expect(await prisma.ride.count({ where: { riderId: simRiderId, status: "REQUESTED" } })).toBe(
      0,
    );
    await prisma.driver.update({ where: { userId: driverId }, data: { isOnline: false } });
  });
});

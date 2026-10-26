/**
 * Rate limits are per PERSON. The guarantee these tests exist for: when user
 * A uses up a limit, user B is unaffected — including when A and B share one
 * IP address (a hostel Wi-Fi, a mobile carrier's NAT). Also: SOS is never
 * refused, every 429 says when to come back, and production can't be loosened.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { prisma } from "../db/prisma";
import { config, rateLimitMultiplier } from "../config";
import { registerAllRoutes } from "../routes";
import { DummyOtpService } from "../services/otp/DummyOtpService";
import { DummyPaymentService } from "../services/payment/DummyPaymentService";
import { signAccessToken, signVerificationToken } from "../services/auth/tokens";
import { login } from "../services/auth/authService";
import { createTestDriver, createTestUser, getTestZones } from "../services/ride/testFixtures";
import { uniqueGhanaPhone } from "../test/testPhone";
import { MemoryRateLimitStore } from "./store";
import { RateLimiter, limiter, setRateLimitStore, type LimitCheck } from "./limiter";
import { RULES, type LimitRule } from "./rules";

vi.mock("../services/sms/sendSms", () => ({
  sendSms: vi.fn().mockResolvedValue({ success: true }),
}));
import { sendSms } from "../services/sms/sendSms";

/** Every request in this file comes from ONE address: the shared hostel Wi-Fi. */
const HOSTEL_IP = "154.160.1.20";

let app: FastifyInstance;
const routeLimits = new Map<string, readonly LimitRule[]>();
const userIds: string[] = [];

beforeAll(async () => {
  app = Fastify();
  app.addHook("onRoute", (route) => {
    const limits = route.config?.limits;
    if (limits && limits.user?.length) {
      for (const m of [route.method].flat()) routeLimits.set(`${m} ${route.url}`, limits.user);
    }
  });
  registerAllRoutes(app, prisma, {
    otpService: new DummyOtpService(),
    paymentService: new DummyPaymentService(),
  });
  await app.ready();
});

beforeEach(() => {
  // A clean slate per test, so one test's counters never decide another's.
  setRateLimitStore(new MemoryRateLimitStore(200_000, 0));
});

afterAll(async () => {
  await prisma.ride.deleteMany({
    where: { OR: [{ riderId: { in: userIds } }, { driverId: { in: userIds } }] },
  });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

async function person(role: "RIDER" | "DRIVER" = "RIDER") {
  const user =
    role === "DRIVER"
      ? (await createTestDriver({ isOnline: true, isApproved: true })).user
      : await createTestUser();
  userIds.push(user.id);
  return { user, token: signAccessToken({ userId: user.id, role: user.role }) };
}

function call(
  method: string,
  url: string,
  opts: { token?: string; payload?: object; ip?: string } = {},
) {
  return app.inject({
    method: method as "GET",
    url,
    remoteAddress: opts.ip ?? HOSTEL_IP,
    headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
    ...(opts.payload && method !== "GET" ? { payload: opts.payload } : {}),
  });
}

/** Uses up a rule for one subject without sending its requests one by one. */
async function exhaust(rule: LimitRule, subject: string) {
  for (let i = 0; i < rule.max; i++) await limiter.consume([{ rule, subject }]);
}

function expect429(res: {
  statusCode: number;
  headers: Record<string, unknown>;
  json: () => unknown;
}) {
  expect(res.statusCode).toBe(429);
  const seconds = Number(res.headers["retry-after"]);
  expect(seconds).toBeGreaterThan(0);
  expect(res.json()).toEqual({
    error: expect.stringMatching(/^Too many attempts\. Try again in .+\.$/),
    code: "RATE_LIMITED",
    retryAfterSeconds: seconds,
  });
}

// ─── The store and the limiter ────────────────────────────────────────────

describe("the limiter", () => {
  const rule: LimitRule = { name: "t", label: "t", subject: "user", max: 3, windowMs: 60_000 };
  const fresh = () => new RateLimiter(new MemoryRateLimitStore(1000, 0));

  it("allows max per window from the first hit, then says how long until it resets", async () => {
    const l = fresh();
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++)
      expect((await l.consume([{ rule, subject: "a" }], t0 + i * 1000)).ok).toBe(true);
    const refused = await l.consume([{ rule, subject: "a" }], t0 + 10_000);
    expect(refused).toEqual({ ok: false, rule, retryAfterMs: 50_000 });
    expect((await l.consume([{ rule, subject: "a" }], t0 + 60_000)).ok).toBe(true);
  });

  it("doesn't count refused requests, so hammering never makes the wait longer", async () => {
    const l = fresh();
    for (let i = 0; i < 3; i++) await l.consume([{ rule, subject: "a" }], 0);
    for (let i = 0; i < 50; i++) await l.consume([{ rule, subject: "a" }], 1000);
    expect((await l.status({ rule, subject: "a" }, 1000)).used).toBe(3);
    expect((await l.consume([{ rule, subject: "a" }], 60_000)).ok).toBe(true);
  });

  it("counts all of a request's limits or none: a refusal by one doesn't spend the others", async () => {
    const l = fresh();
    const person: LimitCheck = { rule, subject: "ama" };
    const backstop: LimitCheck = { rule: { ...rule, name: "ip", max: 1 }, subject: "1.2.3.4" };
    await l.consume([backstop], 0);
    expect((await l.consume([person, backstop], 0)).ok).toBe(false);
    expect((await l.status(person, 0)).used).toBe(0);
  });

  it("reports the longest wait when several limits are full", async () => {
    const l = fresh();
    const short: LimitCheck = {
      rule: { ...rule, name: "short", max: 1, windowMs: 60_000 },
      subject: "a",
    };
    const long: LimitCheck = {
      rule: { ...rule, name: "long", max: 1, windowMs: 3_600_000 },
      subject: "a",
    };
    await l.consume([short, long], 0);
    const refused = await l.consume([short, long], 0);
    expect(refused).toMatchObject({ ok: false, retryAfterMs: 3_600_000 });
  });

  it("keeps different subjects apart", async () => {
    const l = fresh();
    for (let i = 0; i < 3; i++) await l.consume([{ rule, subject: "a" }], 0);
    expect((await l.consume([{ rule, subject: "a" }], 0)).ok).toBe(false);
    expect((await l.consume([{ rule, subject: "b" }], 0)).ok).toBe(true);
  });

  it("forgets expired windows and stays within its key budget", async () => {
    const store = new MemoryRateLimitStore(5, 0);
    for (let i = 0; i < 20; i++) await store.take(`k${i}`, 1000, 1, 0);
    expect(store.size).toBeLessThanOrEqual(5);
    store.sweep(2000);
    expect(store.size).toBe(0);
  });
});

describe("environments", () => {
  it("production always uses the real numbers; development and test are looser", () => {
    expect(rateLimitMultiplier("production", undefined)).toBe(1);
    expect(rateLimitMultiplier("production", "50")).toBe(1);
    expect(rateLimitMultiplier("development", undefined)).toBe(10);
    expect(rateLimitMultiplier("test", "3")).toBe(3);
    expect(rateLimitMultiplier("test", "nonsense")).toBe(10);
    // This suite runs looser too, and every rule reflects it.
    expect(RULES.otpSend15m.max).toBe(
      config.rateLimit.otpSendPer15Min * config.rateLimit.multiplier,
    );
  });
});

// ─── A uses up a limit; B, on the same IP, is unaffected ──────────────────

describe("one person's limit never touches another, even on the same IP", () => {
  it("login codes: A is refused more codes; B, on the same Wi-Fi, gets theirs", async () => {
    const a = uniqueGhanaPhone();
    const b = uniqueGhanaPhone();
    for (let i = 0; i < RULES.otpCooldown.max; i++) {
      expect(
        (await call("POST", "/auth/request-otp", { payload: { phone: a, purpose: "SIGNUP" } }))
          .statusCode,
      ).toBe(200);
    }
    expect429(
      await call("POST", "/auth/request-otp", { payload: { phone: a, purpose: "SIGNUP" } }),
    );
    expect(
      (await call("POST", "/auth/request-otp", { payload: { phone: b, purpose: "SIGNUP" } }))
        .statusCode,
    ).toBe(200);
  });

  it("login codes: each per-number window refuses A only", async () => {
    for (const rule of [RULES.otpSend15m, RULES.otpSend24h]) {
      const a = uniqueGhanaPhone();
      const b = uniqueGhanaPhone();
      await exhaust(rule, a);
      expect429(
        await call("POST", "/auth/request-otp", { payload: { phone: a, purpose: "LOGIN" } }),
      );
      expect(
        (await call("POST", "/auth/request-otp", { payload: { phone: b, purpose: "LOGIN" } }))
          .statusCode,
      ).toBe(200);
    }
  });

  it("code checks: A is locked out of verifying; B verifies from the same IP", async () => {
    const a = uniqueGhanaPhone();
    const b = uniqueGhanaPhone();
    await exhaust(RULES.otpVerify15m, a);
    expect429(
      await call("POST", "/auth/verify-otp", {
        payload: { phone: a, code: "123456", purpose: "LOGIN" },
      }),
    );
    // B has no code waiting: 400, which is the point — not 429.
    expect(
      (
        await call("POST", "/auth/verify-otp", {
          payload: { phone: b, code: "123456", purpose: "LOGIN" },
        })
      ).statusCode,
    ).toBe(400);
  });

  it("log-in and sign-up: A's number is refused; B's isn't", async () => {
    const a = await person();
    const b = await person();
    await exhaust(RULES.login15m, a.user.phone);
    const verified = (phone: string) => signVerificationToken({ phone, purpose: "LOGIN" });
    expect429(
      await call("POST", "/auth/login", {
        payload: { phone: a.user.phone, verifiedToken: verified(a.user.phone) },
      }),
    );
    expect(
      (
        await call("POST", "/auth/login", {
          payload: { phone: b.user.phone, verifiedToken: verified(b.user.phone) },
        })
      ).statusCode,
    ).toBe(200);
  });

  it("token refresh: per login and per account — B keeps refreshing", async () => {
    const a = await person();
    const b = await person();
    const sessionOf = (u: typeof a) =>
      login(prisma, {
        phone: u.user.phone,
        verifiedToken: signVerificationToken({ phone: u.user.phone, purpose: "LOGIN" }),
      });
    const [sa, sb] = [await sessionOf(a), await sessionOf(b)];
    await exhaust(RULES.refreshUser, a.user.id);

    const refused = await call("POST", "/auth/refresh", {
      payload: { refreshToken: sa.refreshToken },
    });
    expect429(refused);
    expect(
      (await call("POST", "/auth/refresh", { payload: { refreshToken: sb.refreshToken } }))
        .statusCode,
    ).toBe(200);
    // A refused refresh doesn't spend the token: it works once the limit clears.
    setRateLimitStore(new MemoryRateLimitStore(1000, 0));
    expect(
      (await call("POST", "/auth/refresh", { payload: { refreshToken: sa.refreshToken } }))
        .statusCode,
    ).toBe(200);
  });

  it("every signed-in route's own limit refuses A and not B (found from the route table)", async () => {
    expect(routeLimits.size).toBeGreaterThanOrEqual(12);
    const { pickup } = await getTestZones();
    for (const [route, rules] of routeLimits) {
      const [method, pattern] = route.split(" ") as [string, string];
      const url = pattern.replace(/:[A-Za-z]+/g, "c-placeholder");
      for (const rule of rules) {
        const a = await person(
          route.includes("/driver") ||
            route.includes("claim") ||
            route.includes("reject") ||
            route.includes("uploads")
            ? "DRIVER"
            : "RIDER",
        );
        const b = await person(
          route.includes("/driver") ||
            route.includes("claim") ||
            route.includes("reject") ||
            route.includes("uploads")
            ? "DRIVER"
            : "RIDER",
        );
        await exhaust(rule, a.user.id);
        const payload = { pickupZoneId: pickup.id, dropoffZoneId: pickup.id, type: "LONE" };
        const refused = await call(method, url, { token: a.token, payload });
        expect(refused.statusCode, `${route} ${rule.name}`).toBe(429);
        expect429(refused);
        expect(
          (await call(method, url, { token: b.token, payload })).statusCode,
          `${route} for B`,
        ).not.toBe(429);
      }
    }
  });

  it("PUT /me/push-token flooded by an app bug: refused on its own limit, the account's other requests unaffected", async () => {
    const a = await person();
    const register = () =>
      call("PUT", "/me/push-token", {
        token: a.token,
        payload: { token: "ExponentPushToken[flood-test-0000000001]", app: "rider", platform: "ios" },
      });
    for (let i = 0; i < RULES.pushToken.max; i++) expect((await register()).statusCode).toBe(200);
    for (let i = 0; i < 50; i++) expect429(await register());

    // None of it was counted against the account's general allowance.
    expect((await limiter.status({ rule: RULES.userDefault, subject: a.user.id })).used).toBe(0);
    expect((await call("GET", "/service-area", { token: a.token })).statusCode).toBe(200);
    await prisma.pushToken.deleteMany({ where: { userId: a.user.id } });
  });

  it("the per-account default refuses A and not B", async () => {
    const a = await person();
    const b = await person();
    await exhaust(RULES.userDefault, a.user.id);
    expect429(await call("GET", "/service-area", { token: a.token }));
    expect((await call("GET", "/service-area", { token: b.token })).statusCode).toBe(200);
  });

  it("booking: A really books up to the hourly cap over HTTP; B books from the same IP after", async () => {
    const a = await person();
    const b = await person();
    const { pickup, dropoff } = await getTestZones();
    const book = (token: string) =>
      call("POST", "/rides", {
        token,
        payload: { pickupZoneId: pickup.id, dropoffZoneId: dropoff.id, type: "LONE" },
      });

    for (let i = 0; i < RULES.rideCreate.max; i++) {
      // A has a ride going, so these are 409s — but they count, as any booking attempt does.
      expect((await book(a.token)).statusCode).not.toBe(429);
    }
    expect429(await book(a.token));
    expect((await book(b.token)).statusCode).toBe(201);
  });
});

// ─── The IP backstop ──────────────────────────────────────────────────────

describe("the IP backstop", () => {
  it("only ever applies where nobody is signed in: a full IP never blocks the people behind it", async () => {
    await exhaust(RULES.ipPublic, HOSTEL_IP);
    // Anonymous traffic from the full IP is refused…
    expect429(await call("POST", "/auth/logout", { payload: { refreshToken: "x" } }));
    // …from another IP it isn't…
    expect(
      (await call("POST", "/auth/logout", { payload: { refreshToken: "x" }, ip: "102.176.65.3" }))
        .statusCode,
    ).toBe(401);
    // …and every signed-in student on the full IP carries on.
    const student = await person();
    expect((await call("GET", "/service-area", { token: student.token })).statusCode).toBe(200);
  });

  it("caps codes from one IP to many numbers (a bot texting all of Ghana), without touching another IP", async () => {
    await exhaust(RULES.ipOtpSend, HOSTEL_IP);
    expect429(
      await call("POST", "/auth/request-otp", {
        payload: { phone: uniqueGhanaPhone(), purpose: "SIGNUP" },
      }),
    );
    const other = await call("POST", "/auth/request-otp", {
      payload: { phone: uniqueGhanaPhone(), purpose: "SIGNUP" },
      ip: "102.176.65.3",
    });
    expect(other.statusCode).toBe(200);
  });

  it("refusing by IP doesn't spend the number's own allowance", async () => {
    const phone = uniqueGhanaPhone();
    await exhaust(RULES.ipOtpSend, HOSTEL_IP);
    await call("POST", "/auth/request-otp", { payload: { phone, purpose: "SIGNUP" } });
    expect((await limiter.status({ rule: RULES.otpCooldown, subject: phone })).used).toBe(0);
  });

  it("bounds junk tokens sent to signed-in routes from one IP", async () => {
    await exhaust(RULES.ipPublic, HOSTEL_IP);
    expect429(await call("GET", "/me", { token: "junk" }));
    expect((await call("GET", "/me", { token: "junk", ip: "102.176.65.3" })).statusCode).toBe(401);
  });
});

// ─── SOS is never refused ─────────────────────────────────────────────────

describe("SOS", () => {
  async function liveRide() {
    const rider = await person();
    const { user: driver } = await createTestDriver({ isOnline: true, isApproved: true });
    userIds.push(driver.id);
    await prisma.user.update({
      where: { id: rider.user.id },
      data: { emergencyContactName: "Auntie Akos", emergencyContactPhone: "+233240000111" },
    });
    const { pickup, dropoff } = await getTestZones();
    const ride = await prisma.ride.create({
      data: {
        riderId: rider.user.id,
        driverId: driver.id,
        type: "LONE",
        status: "IN_PROGRESS",
        pickupZoneId: pickup.id,
        dropoffZoneId: dropoff.id,
      },
    });
    return { rider, ride };
  }
  const sos = (rideId: string, token: string) => call("POST", `/rides/${rideId}/sos`, { token });

  beforeEach(() => {
    vi.mocked(sendSms).mockReset();
    vi.mocked(sendSms).mockResolvedValue({ success: true });
  });

  it("goes through even when the rider has used up every other limit and the IP is full", async () => {
    const { rider, ride } = await liveRide();
    await exhaust(RULES.userDefault, rider.user.id);
    await exhaust(RULES.ipPublic, HOSTEL_IP);
    const res = await sos(ride.id, rider.token);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ smsDelivered: true, alreadyAlerted: false });
    expect(sendSms).toHaveBeenCalledWith("+233240000111", expect.stringContaining("SOS"));
  });

  it("a repeat press is answered (never 429) but doesn't text the same people again", async () => {
    const { rider, ride } = await liveRide();
    const first = await sos(ride.id, rider.token);
    const texts = vi.mocked(sendSms).mock.calls.length;
    for (let i = 0; i < 5; i++) {
      const again = await sos(ride.id, rider.token);
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({
        trackingUrl: first.json().trackingUrl,
        smsDelivered: true,
        alreadyAlerted: true,
      });
    }
    expect(vi.mocked(sendSms).mock.calls.length).toBe(texts);
  });

  it("if a press reached nobody, the next one tries again", async () => {
    const { rider, ride } = await liveRide();
    vi.mocked(sendSms).mockResolvedValue({ success: false });
    expect((await sos(ride.id, rider.token)).json()).toMatchObject({
      smsDelivered: false,
      alreadyAlerted: false,
    });
    vi.mocked(sendSms).mockResolvedValue({ success: true });
    expect((await sos(ride.id, rider.token)).json()).toMatchObject({
      smsDelivered: true,
      alreadyAlerted: false,
    });
  });

  it("each rider on a ride has their own repeat window", async () => {
    const { rider, ride } = await liveRide();
    const other = await person();
    await prisma.ridePassenger.create({
      data: {
        rideId: ride.id,
        riderId: other.user.id,
        pickupZoneId: ride.pickupZoneId,
        dropoffZoneId: ride.dropoffZoneId,
        status: "PICKED_UP",
      },
    });
    await sos(ride.id, rider.token);
    expect((await sos(ride.id, other.token)).json()).toMatchObject({ alreadyAlerted: false });
  });
});

// ─── Tracking links ───────────────────────────────────────────────────────

describe("GET /track/:token", () => {
  it("is limited per link, with Retry-After, and one busy link doesn't affect another", async () => {
    const busy = randomBytes(16).toString("hex");
    const other = randomBytes(16).toString("hex");
    await exhaust(RULES.trackLink, busy);
    const refused = await call("GET", `/track/${busy}`);
    expect(refused.statusCode).toBe(429);
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
    expect(refused.body).toContain("Too many attempts");
    expect((await call("GET", `/track/${other}`)).statusCode).toBe(404);
  });
});

// ─── The admin lookup and reset ───────────────────────────────────────────

describe("admin: look up and clear a number's limits", () => {
  it("shows what is blocked, clears it, and audit-logs both", async () => {
    const admin = await person();
    await prisma.user.update({ where: { id: admin.user.id }, data: { role: "ADMIN" } });
    const ama = await person();
    const kofi = await person();
    await exhaust(RULES.otpCooldown, ama.user.phone);
    await exhaust(RULES.otpCooldown, kofi.user.phone);
    await limiter.consume([{ rule: RULES.rideCreate, subject: ama.user.id }]);

    const local = `0${ama.user.phone.slice(4)}`;
    const view = await call("GET", `/admin/rate-limits?phone=${local}`, { token: admin.token });
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({ phone: ama.user.phone, account: { id: ama.user.id } });
    const limits = view.json().limits as Array<{ name: string; blocked: boolean; scope: string }>;
    expect(limits[0]).toMatchObject({
      name: RULES.otpCooldown.name,
      blocked: true,
      scope: "phone",
    });
    expect(limits.find((l) => l.name === RULES.rideCreate.name)).toMatchObject({
      blocked: false,
      scope: "account",
    });

    const cleared = await call("POST", "/admin/rate-limits/clear", {
      token: admin.token,
      payload: { phone: local },
    });
    expect(cleared.statusCode).toBe(200);
    expect(
      (
        await call("POST", "/auth/request-otp", {
          payload: { phone: ama.user.phone, purpose: "LOGIN" },
        })
      ).statusCode,
    ).toBe(200);
    // Only Ama's limits were cleared.
    expect429(
      await call("POST", "/auth/request-otp", {
        payload: { phone: kofi.user.phone, purpose: "LOGIN" },
      }),
    );

    const audit = await prisma.adminAuditLog.findMany({
      where: { actor: admin.user.id },
      orderBy: { timestamp: "asc" },
    });
    expect(audit.map((r) => r.action)).toEqual(["rate_limit.view", "rate_limit.clear"]);
    expect(audit[1]).toMatchObject({
      target: ama.user.id,
      reason: expect.stringContaining(`${RULES.otpCooldown.name}`),
    });
    await prisma.adminAuditLog.deleteMany({ where: { actor: admin.user.id } });
  });

  it("is admin-only and needs a real number", async () => {
    const rider = await person();
    expect(
      (await call("GET", "/admin/rate-limits?phone=0241234567", { token: rider.token })).statusCode,
    ).toBe(403);
    const admin = await person();
    await prisma.user.update({ where: { id: admin.user.id }, data: { role: "ADMIN" } });
    expect(
      (await call("GET", "/admin/rate-limits?phone=12", { token: admin.token })).statusCode,
    ).toBe(400);
  });
});

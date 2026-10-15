/**
 * Stage 3: who may use the admin site, how long an admin session lasts, and
 * the record of every attempt to sign in to it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "jsonwebtoken";
import { prisma } from "../db/prisma";
import { config } from "../config";
import { registerAllRoutes } from "./index";
import { DummyOtpService } from "../services/otp/DummyOtpService";
import { DummyPaymentService } from "../services/payment/DummyPaymentService";
import { CapturingOtpService } from "../services/auth/testFixtures";
import { registerAuthRoutes } from "./auth";
import { signAccessToken, signVerificationToken } from "../services/auth/tokens";
import { refresh } from "../services/auth/authService";
import { adminPhoneAllowed, maskPhone } from "../services/auth/adminAccess";
import { forgetAccount } from "../services/auth/accountStatus";
import { createTestUser } from "../services/ride/testFixtures";
import { uniqueGhanaPhone } from "../test/testPhone";

let app: FastifyInstance;
let otpApp: FastifyInstance;
const otp = new CapturingOtpService();
const userIds: string[] = [];
const allowlist = config.adminPhoneAllowlist.phones;

beforeAll(async () => {
  app = Fastify();
  registerAllRoutes(app, prisma, {
    otpService: new DummyOtpService(),
    paymentService: new DummyPaymentService(),
  });
  await app.ready();
  // The same auth routes with a code we can read back.
  otpApp = Fastify();
  registerAuthRoutes(otpApp, prisma, otp);
  await otpApp.ready();
});

afterEach(() => {
  allowlist.splice(0, allowlist.length);
});

afterAll(async () => {
  await prisma.adminAuditLog.deleteMany({
    where: { OR: [{ actor: { in: userIds } }, { target: { in: userIds } }] },
  });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
  await otpApp.close();
});

async function account(role: "RIDER" | "ADMIN") {
  const created = await createTestUser("RIDER");
  const user =
    role === "ADMIN"
      ? await prisma.user.update({ where: { id: created.id }, data: { role: "ADMIN" } })
      : created;
  userIds.push(user.id);
  return user;
}

const ADMIN_SITE = {
  "x-campusride-client": "admin",
  "user-agent": "Mozilla/5.0 (Macintosh) Chrome/155.0",
};

function loginRequest(phone: string, headers: Record<string, string> = ADMIN_SITE) {
  return app.inject({
    method: "POST",
    url: "/auth/login",
    remoteAddress: "41.66.200.17",
    headers,
    payload: { phone, verifiedToken: signVerificationToken({ phone, purpose: "LOGIN" }) },
  });
}

async function loginEvents(target: string) {
  return prisma.adminAuditLog.findMany({
    where: { action: { startsWith: "admin.login." }, OR: [{ actor: target }, { target }] },
    orderBy: { timestamp: "asc" },
  });
}

// ─── The allowlist ────────────────────────────────────────────────────────

describe("ADMIN_PHONE_ALLOWLIST", () => {
  it("in production, an empty list lets nobody in; elsewhere it lets any admin in", () => {
    const empty = { phones: [], invalid: [] };
    expect(adminPhoneAllowed("+233241234567", empty, "production")).toBe(false);
    expect(adminPhoneAllowed("+233241234567", empty, "development")).toBe(true);
    const list = { phones: ["+233241234567"], invalid: [] };
    expect(adminPhoneAllowed("+233241234567", list, "production")).toBe(true);
    expect(adminPhoneAllowed("+233200000000", list, "production")).toBe(false);
  });

  it("an ADMIN account off the list gets the same 403 as a rider on every admin route", async () => {
    const listed = await account("ADMIN");
    const unlisted = await account("ADMIN");
    allowlist.push(listed.phone);
    const as = (u: { id: string }) => ({
      authorization: `Bearer ${signAccessToken({ userId: u.id, role: "ADMIN" })}`,
    });

    expect(
      (await app.inject({ method: "GET", url: "/admin/rides", headers: as(listed) })).statusCode,
    ).toBe(200);
    const refused = await app.inject({ method: "GET", url: "/admin/rides", headers: as(unlisted) });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ error: "Admin role required" });
  });

  it("an ADMIN account off the list can't even log in, and the attempt is recorded", async () => {
    const unlisted = await account("ADMIN");
    allowlist.push(uniqueGhanaPhone());
    const res = await loginRequest(unlisted.phone);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({
      error: "This account can't use the admin site.",
      code: "ADMIN_NOT_ALLOWED",
    });
    expect(res.json().accessToken).toBeUndefined();
    const events = await loginEvents(unlisted.id);
    expect(events.at(-1)).toMatchObject({
      action: "admin.login.failure",
      reason: "not_allowlisted",
      ip: "41.66.200.17",
    });
  });

  it("taking a number off the list ends its admin session at the next renewal", async () => {
    const admin = await account("ADMIN");
    allowlist.push(admin.phone);
    const session = (await loginRequest(admin.phone)).json();
    allowlist.splice(0, allowlist.length, uniqueGhanaPhone());
    forgetAccount(admin.id);

    const res = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken: session.refreshToken },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("ADMIN_SESSION_ENDED");
    expect(await prisma.refreshToken.count({ where: { userId: admin.id, revokedAt: null } })).toBe(
      0,
    );
  });
});

// ─── Admin sessions ───────────────────────────────────────────────────────

describe("admin sessions are short", () => {
  const s = config.adminSession;
  const MIN = 60_000;

  it("an admin gets a 10-minute access token, a refresh token that dies after 30 idle minutes, and an 8-hour end", async () => {
    const admin = await account("ADMIN");
    const before = Date.now();
    const res = await loginRequest(admin.phone);
    expect(res.statusCode).toBe(200);
    const body = res.json();

    const access = jwt.decode(body.accessToken) as { exp: number; iat: number };
    expect(access.exp - access.iat).toBe(s.accessTokenMinutes * 60);
    const stored = await prisma.refreshToken.findFirstOrThrow({
      where: { userId: admin.id, revokedAt: null },
    });
    expect(stored.expiresAt.getTime() - before).toBeGreaterThanOrEqual(s.idleMinutes * MIN - 5_000);
    expect(stored.expiresAt.getTime() - before).toBeLessThanOrEqual(s.idleMinutes * MIN + 5_000);
    expect(Date.parse(body.sessionExpiresAt) - before).toBeGreaterThan(
      s.maxHours * 60 * MIN - 5_000,
    );
    expect(Date.parse(body.sessionExpiresAt) - before).toBeLessThan(s.maxHours * 60 * MIN + 5_000);
  });

  it("renewing keeps the same hard end, and nothing outlives it", async () => {
    const admin = await account("ADMIN");
    const login = (await loginRequest(admin.phone)).json();
    const t0 = Date.now();

    // Renewed 7h50m in: the new access token stops at the 8-hour mark.
    const late = new Date(t0 + (s.maxHours * 60 - 10) * MIN);
    await prisma.refreshToken.updateMany({
      where: { userId: admin.id },
      data: { expiresAt: new Date(late.getTime() + MIN) },
    });
    const renewed = await refresh(prisma, login.refreshToken, late);
    expect(renewed.sessionExpiresAt).toBe(login.sessionExpiresAt);
    const access = jwt.decode(renewed.accessToken) as { exp: number; iat: number };
    expect(access.exp * 1000).toBeLessThanOrEqual(Date.parse(login.sessionExpiresAt) + 1000);
    expect(access.exp - access.iat).toBeLessThanOrEqual(10 * 60 + 1);
  });

  it("after the hard end, renewal is refused and the whole login revoked", async () => {
    const admin = await account("ADMIN");
    const login = (await loginRequest(admin.phone)).json();
    const after = new Date(Date.parse(login.sessionExpiresAt) + MIN);
    await prisma.refreshToken.updateMany({
      where: { userId: admin.id },
      data: { expiresAt: new Date(after.getTime() + MIN) },
    });
    await expect(refresh(prisma, login.refreshToken, after)).rejects.toMatchObject({
      name: "AdminSessionEndedError",
      reason: "max_length",
    });
    expect(await prisma.refreshToken.count({ where: { userId: admin.id, revokedAt: null } })).toBe(
      0,
    );
  });

  it("after 30 idle minutes the refresh token has simply expired", async () => {
    const admin = await account("ADMIN");
    const login = (await loginRequest(admin.phone)).json();
    const idle = new Date(Date.now() + (s.idleMinutes + 1) * MIN);
    await expect(refresh(prisma, login.refreshToken, idle)).rejects.toMatchObject({
      name: "InvalidRefreshTokenError",
    });
  });

  it("riders keep their usual sessions", async () => {
    const rider = await account("RIDER");
    const res = await loginRequest(rider.phone, {});
    const body = res.json();
    expect(body.sessionExpiresAt).toBeUndefined();
    const access = jwt.decode(body.accessToken) as { exp: number; iat: number };
    expect(access.exp - access.iat).toBe(30 * 60);
  });
});

// ─── Logging in through the admin site ────────────────────────────────────

describe("the admin site's login", () => {
  it("gives a rider no session, says why, and records the attempt with IP and device", async () => {
    const rider = await account("RIDER");
    const res = await loginRequest(rider.phone);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({
      error: "This account is not an administrator.",
      code: "NOT_AN_ADMIN",
    });
    expect(await prisma.refreshToken.count({ where: { userId: rider.id } })).toBe(0);
    expect((await loginEvents(rider.id)).at(-1)).toMatchObject({
      action: "admin.login.failure",
      reason: "not_admin",
      ip: "41.66.200.17",
      userAgent: ADMIN_SITE["user-agent"],
    });
  });

  it("the same rider logging in through the rider app is not recorded", async () => {
    const rider = await account("RIDER");
    expect((await loginRequest(rider.phone, {})).statusCode).toBe(200);
    expect(await loginEvents(rider.id)).toHaveLength(0);
  });
});

describe("the record of admin sign-ins", () => {
  it("records a code sent, a wrong code and a success for an admin's number — from any app", async () => {
    const admin = await account("ADMIN");
    const post = (url: string, payload: object) =>
      otpApp.inject({
        method: "POST",
        url,
        payload,
        remoteAddress: "102.176.65.3",
        headers: { "user-agent": "okhttp/4.12" },
      });

    expect(
      (await post("/auth/request-otp", { phone: admin.phone, purpose: "LOGIN" })).statusCode,
    ).toBe(200);
    const wrong = otp.codeFor(admin.phone) === "000000" ? "111111" : "000000";
    expect(
      (await post("/auth/verify-otp", { phone: admin.phone, code: wrong, purpose: "LOGIN" }))
        .statusCode,
    ).toBe(400);
    const { verifiedToken } = (
      await post("/auth/verify-otp", {
        phone: admin.phone,
        code: otp.codeFor(admin.phone),
        purpose: "LOGIN",
      })
    ).json();
    expect((await post("/auth/login", { phone: admin.phone, verifiedToken })).statusCode).toBe(200);

    const events = await loginEvents(admin.id);
    expect(events.map((e) => [e.action, e.reason])).toEqual([
      ["admin.login.code_sent", null],
      ["admin.login.failure", "bad_code"],
      ["admin.login.success", null],
    ]);
    expect(events.every((e) => e.ip === "102.176.65.3" && e.userAgent === "okhttp/4.12")).toBe(
      true,
    );
  });

  it("a stranger's number tried on the admin site is recorded, masked", async () => {
    const stranger = uniqueGhanaPhone();
    const res = await loginRequest(stranger);
    expect(res.statusCode).toBe(404);
    const [event] = await loginEvents(maskPhone(stranger));
    expect(event).toMatchObject({
      actor: "unknown",
      action: "admin.login.failure",
      reason: "no_account",
      target: maskPhone(stranger),
    });
    expect(event!.target).not.toContain(stranger.slice(4, 9));
    await prisma.adminAuditLog.deleteMany({ where: { target: maskPhone(stranger) } });
  });

  it("shows on GET /admin/audit/logins, newest first, to admins only", async () => {
    const admin = await account("ADMIN");
    await loginRequest(admin.phone);
    const rider = await account("RIDER");
    await loginRequest(rider.phone); // refused: not an admin

    const res = await app.inject({
      method: "GET",
      url: "/admin/audit/logins",
      headers: { authorization: `Bearer ${signAccessToken({ userId: admin.id, role: "ADMIN" })}` },
    });
    expect(res.statusCode).toBe(200);
    const logins = res.json().logins as Array<{
      outcome: string;
      reason: string | null;
      account: { id: string } | null;
      ip: string;
      at: string;
    }>;
    const mine = logins.filter((l) => l.account && [admin.id, rider.id].includes(l.account.id));
    expect(mine[0]).toMatchObject({
      outcome: "failure",
      reason: "not_admin",
      account: { id: rider.id },
      ip: "41.66.200.17",
    });
    expect(mine[1]).toMatchObject({ outcome: "success", account: { id: admin.id } });
    expect(Date.parse(logins[0]!.at)).toBeGreaterThanOrEqual(
      Date.parse(logins[logins.length - 1]!.at),
    );

    const asRider = await app.inject({
      method: "GET",
      url: "/admin/audit/logins",
      headers: { authorization: `Bearer ${signAccessToken({ userId: rider.id, role: "RIDER" })}` },
    });
    expect(asRider.statusCode).toBe(403);
  });
});

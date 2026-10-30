import { describe, it, expect, afterEach, afterAll, beforeAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "jsonwebtoken";
import { prisma } from "../db/prisma";
import { config } from "../config";
import { registerAuthRoutes } from "./auth";
import { RULES } from "../rateLimit/rules";
import {
  CapturingOtpService,
  cleanupOtpCodes,
  cleanupUser,
  uniqueTestPhone,
} from "../services/auth/testFixtures";
import { limiter, setRateLimitStore } from "../rateLimit/limiter";
import { MemoryRateLimitStore } from "../rateLimit/store";
import { createTestDriver, createTestRide, cleanupRide, createTestUser } from "../services/ride/testFixtures";
import { TERMS_VERSION, needsTermsConfirmation } from "@rida/shared";
import { sha256 } from "../services/auth/hash";
import { TOKEN } from "../services/auth/constants";

/** Moves a used refresh token's revocation `minutes` into the past. */
async function backdateRevocation(refreshToken: string, minutes: number): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { tokenHash: sha256(refreshToken) },
    data: { revokedAt: new Date(Date.now() - minutes * 60_000) },
  });
}

let app: FastifyInstance;
let otpService: CapturingOtpService;

const phones: string[] = [];
const userIds: string[] = [];

beforeAll(async () => {
  otpService = new CapturingOtpService();
  app = Fastify();
  registerAuthRoutes(app, prisma, otpService);
  await app.ready();
});

afterEach(async () => {
  while (userIds.length > 0) {
    await cleanupUser(userIds.pop()!);
  }
  while (phones.length > 0) {
    await cleanupOtpCodes(phones.pop()!);
  }
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

function newPhone(): string {
  const phone = uniqueTestPhone();
  phones.push(phone);
  return phone;
}

async function requestAndVerify(phone: string, purpose: "SIGNUP" | "LOGIN") {
  const requestRes = await app.inject({
    method: "POST",
    url: "/auth/request-otp",
    payload: { phone, purpose },
  });
  expect(requestRes.statusCode).toBe(200);

  const code = otpService.codeFor(phone);

  const verifyRes = await app.inject({
    method: "POST",
    url: "/auth/verify-otp",
    payload: { phone, code, purpose },
  });
  expect(verifyRes.statusCode).toBe(200);

  return JSON.parse(verifyRes.body).verifiedToken as string;
}

describe("auth routes — signup + login round trip", () => {
  it("signs up a RIDER, then logs in with a fresh OTP", async () => {
    const phone = newPhone();
    const verifiedToken = await requestAndVerify(phone, "SIGNUP");

    const signupRes = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { ageAndTermsConfirmed: true, phone, name: "Test Rider", role: "RIDER", verifiedToken },
    });
    expect(signupRes.statusCode).toBe(201);
    const signupBody = JSON.parse(signupRes.body);
    userIds.push(signupBody.user.id);
    expect(signupBody.user.role).toBe("RIDER");
    expect(signupBody.accessToken).toEqual(expect.any(String));
    expect(signupBody.refreshToken).toEqual(expect.any(String));

    const loginVerifiedToken = await requestAndVerify(phone, "LOGIN");
    const loginRes = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { phone, verifiedToken: loginVerifiedToken },
    });
    expect(loginRes.statusCode).toBe(200);
    const loginBody = JSON.parse(loginRes.body);
    expect(loginBody.user.id).toBe(signupBody.user.id);
  });

  it("includes the driver profile (with carMake) in a DRIVER's login response", async () => {
    const phone = newPhone();
    const signupVerifiedToken = await requestAndVerify(phone, "SIGNUP");

    const signupRes = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: {
        ageAndTermsConfirmed: true,
        phone,
        name: "Onboarded Driver",
        role: "DRIVER",
        verifiedToken: signupVerifiedToken,
      },
    });
    expect(signupRes.statusCode).toBe(201);
    const signupBody = JSON.parse(signupRes.body);
    userIds.push(signupBody.user.id);
    // A freshly signed-up driver has a driver row but a null carMake.
    expect(signupBody.user.driver).not.toBeNull();
    expect(signupBody.user.driver.carMake).toBeNull();

    // Complete onboarding so carMake is non-null — the field the driver app's
    // onboarding gate reads.
    const profileRes = await app.inject({
      method: "POST",
      url: "/driver/profile",
      headers: { authorization: `Bearer ${signupBody.accessToken}` },
      payload: { carMake: "Toyota", carModel: "Corolla", carColor: "White", plate: "GR-1234-26" },
    });
    expect(profileRes.statusCode).toBe(200);

    const loginVerifiedToken = await requestAndVerify(phone, "LOGIN");
    const loginRes = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { phone, verifiedToken: loginVerifiedToken },
    });
    expect(loginRes.statusCode).toBe(200);
    const loginBody = JSON.parse(loginRes.body);
    expect(loginBody.user.id).toBe(signupBody.user.id);
    // Regression guard: login must surface the same `user.driver` shape as /me,
    // so the onboarding gate doesn't re-trigger after logout→login.
    expect(loginBody.user.driver).not.toBeNull();
    expect(loginBody.user.driver.carMake).toBe("Toyota");
  });

  it("rejects signup with a verifiedToken for the wrong purpose", async () => {
    const phone = newPhone();
    const loginVerifiedToken = await requestAndVerify(phone, "LOGIN");

    const signupRes = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { ageAndTermsConfirmed: true, phone, name: "Bad Token", role: "RIDER", verifiedToken: loginVerifiedToken },
    });
    expect(signupRes.statusCode).toBe(401);
  });

  it("rejects login for a phone with no account", async () => {
    const phone = newPhone();
    const verifiedToken = await requestAndVerify(phone, "LOGIN");

    const loginRes = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { phone, verifiedToken },
    });
    expect(loginRes.statusCode).toBe(404);
  });

  it("rejects verify-otp with the wrong code", async () => {
    const phone = newPhone();
    await app.inject({
      method: "POST",
      url: "/auth/request-otp",
      payload: { phone, purpose: "SIGNUP" },
    });

    const verifyRes = await app.inject({
      method: "POST",
      url: "/auth/verify-otp",
      payload: { phone, code: "000000", purpose: "SIGNUP" },
    });
    expect(verifyRes.statusCode).toBe(400);
  });

  it("refuses a second code within the minute with a 429, Retry-After and a short wait (not a limit reached)", async () => {
    const phone = newPhone();

    for (let i = 0; i < RULES.otpCooldown.max; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/auth/request-otp",
        payload: { phone, purpose: "SIGNUP" },
      });
      expect(res.statusCode).toBe(200);
    }

    const refused = await app.inject({
      method: "POST",
      url: "/auth/request-otp",
      payload: { phone, purpose: "SIGNUP" },
    });
    expect(refused.statusCode).toBe(429);
    const seconds = Number(refused.headers["retry-after"]);
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThanOrEqual(RULES.otpCooldown.windowMs / 1000);
    // The app opens the code screen on this one: the code that went out is
    // probably on its way (a "Send code" that timed out, then went through).
    expect(refused.json()).toEqual({
      error: expect.stringMatching(/^Wait \d:\d\d before asking for a new code\.$/),
      code: "RATE_LIMITED",
      retryAfterSeconds: seconds,
      limit: "OTP_COOLDOWN",
    });
  });

  it("names only the cooldown: a number out of codes for 15 minutes gets the plain limit", async () => {
    const phone = newPhone();
    for (let i = 0; i < RULES.otpSend15m.max; i++) {
      await limiter.consume([{ rule: RULES.otpSend15m, subject: phone }]);
    }
    const refused = await app.inject({ method: "POST", url: "/auth/request-otp", payload: { phone, purpose: "LOGIN" } });
    expect(refused.statusCode).toBe(429);
    expect(refused.json().limit).toBeUndefined();
    expect(refused.json().error).toMatch(/^Too many attempts/);
  });
});

describe("refresh + logout routes", () => {
  it("refreshes tokens and rejects reuse of the rotated token", async () => {
    const phone = newPhone();
    const verifiedToken = await requestAndVerify(phone, "SIGNUP");

    const signupRes = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { ageAndTermsConfirmed: true, phone, name: "Refresh Route User", role: "RIDER", verifiedToken },
    });
    const { user, refreshToken } = JSON.parse(signupRes.body);
    userIds.push(user.id);

    const refreshRes = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken },
    });
    expect(refreshRes.statusCode).toBe(200);
    const { refreshToken: newRefreshToken } = JSON.parse(refreshRes.body);

    // Long enough ago that it can't be the phone retrying a lost answer.
    await backdateRevocation(refreshToken, TOKEN.REFRESH_RETRY_GRACE_MINUTES + 1);

    const reuseRes = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken },
    });
    expect(reuseRes.statusCode).toBe(401);

    // Phase 2: reusing a consumed token is treated as theft, so the whole
    // rotation family is revoked — including the token the legitimate client
    // was holding. It must therefore no longer refresh either.
    const afterReuseRes = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken: newRefreshToken },
    });
    expect(afterReuseRes.statusCode).toBe(401);

    // The 401 body is byte-identical to an ordinary invalid-token rejection,
    // so a thief cannot tell that they tripped the detector.
    expect(JSON.parse(reuseRes.body)).toEqual(JSON.parse(afterReuseRes.body));
  });

  it("a retry of a refresh whose answer was lost keeps the user signed in", async () => {
    const phone = newPhone();
    const verifiedToken = await requestAndVerify(phone, "SIGNUP");

    const signupRes = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { ageAndTermsConfirmed: true, phone, name: "Retry Route User", role: "RIDER", verifiedToken },
    });
    const { user, refreshToken } = JSON.parse(signupRes.body);
    userIds.push(user.id);

    // Served, but the phone never hears back...
    const lost = await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken } });
    expect(lost.statusCode).toBe(200);

    // ...so it sends the same token again: still signed in.
    const retry = await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken } });
    expect(retry.statusCode).toBe(200);
    const next = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken: retry.json().refreshToken },
    });
    expect(next.statusCode).toBe(200);
  });

  it("logout revokes the current token without needing a reuse event", async () => {
    const phone = newPhone();
    const verifiedToken = await requestAndVerify(phone, "SIGNUP");

    const signupRes = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { ageAndTermsConfirmed: true, phone, name: "Logout Route User", role: "RIDER", verifiedToken },
    });
    const { user, refreshToken } = JSON.parse(signupRes.body);
    userIds.push(user.id);

    const refreshRes = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken },
    });
    expect(refreshRes.statusCode).toBe(200);
    const { refreshToken: newRefreshToken } = JSON.parse(refreshRes.body);

    const logoutRes = await app.inject({
      method: "POST",
      url: "/auth/logout",
      payload: { refreshToken: newRefreshToken },
    });
    expect(logoutRes.statusCode).toBe(200);

    const afterLogoutRes = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken: newRefreshToken },
    });
    expect(afterLogoutRes.statusCode).toBe(401);
  });

  it("rejects refresh with an unknown token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken: "not-a-real-token" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("auth middleware + /me", () => {
  async function signUpUser(role: "RIDER" | "DRIVER" = "RIDER") {
    const phone = newPhone();
    const verifiedToken = await requestAndVerify(phone, "SIGNUP");

    const signupRes = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { ageAndTermsConfirmed: true, phone, name: "Middleware User", role, verifiedToken },
    });
    const body = JSON.parse(signupRes.body);
    userIds.push(body.user.id);
    return body as { user: { id: string }; accessToken: string; refreshToken: string };
  }

  it("returns the current user for a valid access token", async () => {
    const { user, accessToken } = await signUpUser();

    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).user.id).toBe(user.id);
  });

  it("rejects /me with no Authorization header", async () => {
    const res = await app.inject({ method: "GET", url: "/me" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects /me with a malformed token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: "Bearer not-a-jwt" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects /me with an expired access token", async () => {
    const { user } = await signUpUser();
    const expiredToken = jwt.sign({ userId: user.id, role: "RIDER" }, config.jwtSecret, {
      expiresIn: "-1s",
    });

    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${expiredToken}` },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("driver profile route", () => {
  it("completes a DRIVER profile and rejects RIDER accounts", async () => {
    const driverPhone = newPhone();
    const driverVerifiedToken = await requestAndVerify(driverPhone, "SIGNUP");
    const driverSignup = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: {
        ageAndTermsConfirmed: true,
        phone: driverPhone,
        name: "Driver Profile",
        role: "DRIVER",
        verifiedToken: driverVerifiedToken,
      },
    });
    const driverBody = JSON.parse(driverSignup.body);
    userIds.push(driverBody.user.id);

    const profileRes = await app.inject({
      method: "POST",
      url: "/driver/profile",
      headers: { authorization: `Bearer ${driverBody.accessToken}` },
      payload: {
        carMake: "Honda",
        carModel: "Civic",
        carColor: "Black",
        plate: "GE-9999-26",
      },
    });
    expect(profileRes.statusCode).toBe(200);
    expect(JSON.parse(profileRes.body).driver.carMake).toBe("Honda");

    const riderPhone = newPhone();
    const riderVerifiedToken = await requestAndVerify(riderPhone, "SIGNUP");
    const riderSignup = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: {
        ageAndTermsConfirmed: true,
        phone: riderPhone,
        name: "Rider Profile",
        role: "RIDER",
        verifiedToken: riderVerifiedToken,
      },
    });
    const riderBody = JSON.parse(riderSignup.body);
    userIds.push(riderBody.user.id);

    const riderProfileRes = await app.inject({
      method: "POST",
      url: "/driver/profile",
      headers: { authorization: `Bearer ${riderBody.accessToken}` },
      payload: {
        carMake: "Honda",
        carModel: "Civic",
        carColor: "Black",
        plate: "GE-0000-26",
        photoUrl: "https://placeholder.example.com/civic.jpg",
      },
    });
    expect(riderProfileRes.statusCode).toBe(403);
  });
});

describe("DELETE /me", () => {
  /** A fresh rider, signed in. */
  async function signedUpRider(name: string) {
    const phone = newPhone();
    const verifiedToken = await requestAndVerify(phone, "SIGNUP");
    const signupRes = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { ageAndTermsConfirmed: true, phone, name, role: "RIDER", verifiedToken },
    });
    const { user, accessToken, refreshToken } = JSON.parse(signupRes.body);
    userIds.push(user.id);
    return { user, phone, refreshToken, auth: { authorization: `Bearer ${accessToken}` } };
  }

  /** The app's two steps: ask for a code, then delete with it. */
  async function deleteWithCode(auth: Record<string, string>, phone: string) {
    // The sign-up code was sent seconds ago; one code a minute per number.
    setRateLimitStore(new MemoryRateLimitStore(10_000, 0));
    const sent = await app.inject({ method: "POST", url: "/me/deletion-code", headers: auth });
    expect(sent.statusCode).toBe(200);
    return app.inject({
      method: "DELETE",
      url: "/me",
      headers: auth,
      payload: { code: otpService.codeFor(phone) },
    });
  }

  it("requires auth", async () => {
    expect(
      (await app.inject({ method: "DELETE", url: "/me", payload: { code: "123456" } })).statusCode,
    ).toBe(401);
    expect((await app.inject({ method: "POST", url: "/me/deletion-code" })).statusCode).toBe(401);
  });

  it("texts the code to the account's own phone, and says where (masked)", async () => {
    const { phone, auth } = await signedUpRider("Code Asker");
    setRateLimitStore(new MemoryRateLimitStore(10_000, 0));
    const res = await app.inject({ method: "POST", url: "/me/deletion-code", headers: auth });
    expect(res.json()).toEqual({ sent: true, phone: `+233*****${phone.slice(-3)}` });
    expect(await prisma.otpCode.count({ where: { phone, purpose: "ACCOUNT_DELETION" } })).toBe(1);
  });

  it("closes the account with the right code and ends the session", async () => {
    const { user, phone, refreshToken, auth } = await signedUpRider("Deleting User");

    const res = await deleteWithCode(auth, phone);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: true, erasedAfter: expect.any(String) });

    // The refresh token is dead, so the session cannot be extended.
    const refreshRes = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken },
    });
    expect(refreshRes.statusCode).toBe(401);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.deletedAt).not.toBeNull();
    expect(row.phone).not.toBe(phone);
    expect(
      await prisma.adminAuditLog.count({ where: { action: "account.delete", target: user.id } }),
    ).toBe(1);
  });

  it("refuses without a code, or with a wrong one, and changes nothing", async () => {
    const { user, auth } = await signedUpRider("Careful User");
    const none = await app.inject({ method: "DELETE", url: "/me", headers: auth });
    expect(none.statusCode).toBe(400);
    expect(none.json().error).toMatch(/code/);

    setRateLimitStore(new MemoryRateLimitStore(10_000, 0));
    await app.inject({ method: "POST", url: "/me/deletion-code", headers: auth });
    const wrong = await app.inject({
      method: "DELETE",
      url: "/me",
      headers: auth,
      payload: { code: "000000" },
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error).toBe("That code isn't right. Check the text message and try again.");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).deletedAt).toBeNull();
  });

  it("a login code can't confirm a deletion", async () => {
    const { phone, auth } = await signedUpRider("Mixed Codes");
    setRateLimitStore(new MemoryRateLimitStore(10_000, 0));
    await app.inject({
      method: "POST",
      url: "/auth/request-otp",
      payload: { phone, purpose: "LOGIN" },
    });
    const res = await app.inject({
      method: "DELETE",
      url: "/me",
      headers: auth,
      payload: { code: otpService.codeFor(phone) },
    });
    expect(res.statusCode).toBe(400);
  });

  it("is blocked while a ride is going on, with a friendly message, before any code is sent", async () => {
    const { user: driver } = await createTestDriver();
    const { ride, rider } = await createTestRide({
      type: "LONE",
      status: "MATCHED",
      driverId: driver.id,
    });
    try {
      for (const userId of [rider.id, driver.id]) {
        const auth = {
          authorization: `Bearer ${jwt.sign({ userId, role: userId === driver.id ? "DRIVER" : "RIDER", typ: "access" }, config.jwtSecret, { algorithm: "HS256" })}`,
        };
        const res = await app.inject({ method: "POST", url: "/me/deletion-code", headers: auth });
        expect(res.statusCode).toBe(409);
        expect(res.json()).toMatchObject({
          error: expect.stringContaining("Finish or cancel it first"),
          rideId: ride.id,
        });
      }
      expect(
        await prisma.otpCode.count({ where: { purpose: "ACCOUNT_DELETION", phone: rider.phone } }),
      ).toBe(0);
    } finally {
      await cleanupRide(ride.id);
    }
  });

  it("refuses the deleted account's still-unexpired access token from then on", async () => {
    const { phone, auth } = await signedUpRider("Twice Deleting");
    expect((await deleteWithCode(auth, phone)).statusCode).toBe(200);
    // The token is unexpired but its account is closed: 401, like any dead session.
    expect(
      (await app.inject({ method: "POST", url: "/me/deletion-code", headers: auth })).statusCode,
    ).toBe(401);
    expect((await app.inject({ method: "GET", url: "/me", headers: auth })).statusCode).toBe(401);
  });
});

describe("18+ and terms confirmation", () => {
  async function signupWith(extra: Record<string, unknown>) {
    const phone = newPhone();
    const verifiedToken = await requestAndVerify(phone, "SIGNUP");
    const res = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { phone, name: "Terms Person", role: "RIDER", verifiedToken, ...extra },
    });
    if (res.statusCode === 201) userIds.push(res.json().user.id);
    return { res, phone };
  }

  it("refuses a sign-up without it (an old app, or a skipped tick), creating nothing", async () => {
    for (const extra of [{}, { ageAndTermsConfirmed: false }]) {
      setRateLimitStore(new MemoryRateLimitStore(10_000, 0));
      const { res, phone } = await signupWith(extra);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: "TERMS_NOT_CONFIRMED", error: expect.stringContaining("18 or older") });
      expect(await prisma.user.findUnique({ where: { phone } })).toBeNull();
    }
  });

  it("records when, and which version of the terms, and says so to the app", async () => {
    const before = Date.now();
    const { res } = await signupWith({ ageAndTermsConfirmed: true });
    expect(res.statusCode).toBe(201);
    const { user, accessToken } = res.json();
    expect(user).toMatchObject({ termsVersion: TERMS_VERSION });
    expect(needsTermsConfirmation(user)).toBe(false);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.termsAcceptedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row.ageConfirmedAt).toEqual(row.termsAcceptedAt);

    const me = await app.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${accessToken}` } });
    expect(me.json().user).toMatchObject({ termsVersion: TERMS_VERSION, termsAcceptedAt: expect.any(String) });
  });

  it("an account from before sign-up asked confirms once with POST /me/terms", async () => {
    const old = await createTestUser("RIDER");
    userIds.push(old.id);
    const auth = { authorization: `Bearer ${jwt.sign({ userId: old.id, role: "RIDER", typ: "access" }, config.jwtSecret, { algorithm: "HS256" })}` };

    const me = await app.inject({ method: "GET", url: "/me", headers: auth });
    expect(me.json().user).toMatchObject({ termsAcceptedAt: null, ageConfirmedAt: null, termsVersion: null });
    expect(needsTermsConfirmation(me.json().user)).toBe(true);

    const refused = await app.inject({ method: "POST", url: "/me/terms", headers: auth, payload: { ageAndTermsConfirmed: false } });
    expect(refused.statusCode).toBe(400);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: old.id } })).termsAcceptedAt).toBeNull();

    const ok = await app.inject({ method: "POST", url: "/me/terms", headers: auth, payload: { ageAndTermsConfirmed: true } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().user).toMatchObject({ id: old.id, termsVersion: TERMS_VERSION });
    expect(needsTermsConfirmation(ok.json().user)).toBe(false);
  });

  it("POST /me/terms needs a signed-in account", async () => {
    expect(
      (await app.inject({ method: "POST", url: "/me/terms", payload: { ageAndTermsConfirmed: true } })).statusCode,
    ).toBe(401);
  });
});

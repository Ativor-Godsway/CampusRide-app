import { describe, it, expect, afterEach, afterAll, beforeAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "jsonwebtoken";
import { prisma } from "../db/prisma";
import { config } from "../config";
import { registerAuthRoutes } from "./auth";
import { OTP } from "../services/auth/constants";
import { CapturingOtpService, cleanupOtpCodes, cleanupUser, uniqueTestPhone } from "../services/auth/testFixtures";

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
      payload: { phone, name: "Test Rider", role: "RIDER", verifiedToken },
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
      payload: { phone, name: "Onboarded Driver", role: "DRIVER", verifiedToken: signupVerifiedToken },
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
      payload: { phone, name: "Bad Token", role: "RIDER", verifiedToken: loginVerifiedToken },
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

  it("rejects the 4th OTP request within 15 minutes with 429", async () => {
    const phone = newPhone();

    for (let i = 0; i < OTP.OTP_MAX_SENDS_PER_15MIN; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/auth/request-otp",
        payload: { phone, purpose: "SIGNUP" },
      });
      expect(res.statusCode).toBe(200);
    }

    const fourth = await app.inject({
      method: "POST",
      url: "/auth/request-otp",
      payload: { phone, purpose: "SIGNUP" },
    });
    expect(fourth.statusCode).toBe(429);
  });
});

describe("refresh + logout routes", () => {
  it("refreshes tokens and rejects reuse of the rotated token", async () => {
    const phone = newPhone();
    const verifiedToken = await requestAndVerify(phone, "SIGNUP");

    const signupRes = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { phone, name: "Refresh Route User", role: "RIDER", verifiedToken },
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

    const reuseRes = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken },
    });
    expect(reuseRes.statusCode).toBe(401);

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
      payload: { phone, name: "Middleware User", role, verifiedToken },
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
      payload: { phone: driverPhone, name: "Driver Profile", role: "DRIVER", verifiedToken: driverVerifiedToken },
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
        photoUrl: "https://placeholder.example.com/civic.jpg",
      },
    });
    expect(profileRes.statusCode).toBe(200);
    expect(JSON.parse(profileRes.body).driver.carMake).toBe("Honda");

    const riderPhone = newPhone();
    const riderVerifiedToken = await requestAndVerify(riderPhone, "SIGNUP");
    const riderSignup = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { phone: riderPhone, name: "Rider Profile", role: "RIDER", verifiedToken: riderVerifiedToken },
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

/**
 * ONE PHONE ENTRY (POST /auth/verify-code, routes/auth.ts): the apps ask for
 * a code with /auth/request-otp (purpose LOGIN) and learn whether the number
 * has an account only once the code is right. Existing account: signed in.
 * New number: a SIGNUP token for /auth/signup's name + 18+ step.
 */
import { describe, it, expect, afterEach, afterAll, beforeAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { TERMS_VERSION } from "@rida/shared";
import { prisma } from "../db/prisma";
import { registerAuthRoutes } from "./auth";
import {
  CapturingOtpService,
  cleanupOtpCodes,
  cleanupUser,
  uniqueTestPhone,
} from "../services/auth/testFixtures";
import { createTestUser } from "../services/ride/testFixtures";
import { deleteAccount } from "../services/auth/deleteAccount";
import { setRateLimitStore } from "../rateLimit/limiter";
import { MemoryRateLimitStore } from "../rateLimit/store";
import { RULES } from "../rateLimit/rules";

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

// Each test starts with fresh limits (one code a minute per number).
beforeEach(() => setRateLimitStore(new MemoryRateLimitStore(10_000, 0)));

afterEach(async () => {
  while (userIds.length > 0) await cleanupUser(userIds.pop()!);
  while (phones.length > 0) await cleanupOtpCodes(phones.pop()!);
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

async function existingRider() {
  const user = await createTestUser("RIDER");
  userIds.push(user.id);
  phones.push(user.phone);
  return user;
}

const requestCode = (phone: string) =>
  app.inject({ method: "POST", url: "/auth/request-otp", payload: { phone, purpose: "LOGIN" } });

const verifyCode = (phone: string, code: string) =>
  app.inject({ method: "POST", url: "/auth/verify-code", payload: { phone, code } });

describe("POST /auth/verify-code", () => {
  it("signs an existing account straight in, with a working session", async () => {
    const user = await existingRider();
    expect((await requestCode(user.phone)).statusCode).toBe(200);

    const res = await verifyCode(user.phone, otpService.codeFor(user.phone));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("signedIn");
    expect(body.user.id).toBe(user.id);
    expect(typeof body.accessToken).toBe("string");

    const refreshed = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken: body.refreshToken },
    });
    expect(refreshed.statusCode).toBe(200);
  });

  it("a new number gets a sign-up token, and no account until the name + 18+ step", async () => {
    const phone = newPhone();
    await requestCode(phone);

    const res = await verifyCode(phone, otpService.codeFor(phone));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({ status: "newAccount", verifiedToken: expect.any(String) });
    expect(await prisma.user.findUnique({ where: { phone } })).toBeNull();

    const signup = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: {
        phone,
        name: "Ama Owusu",
        role: "RIDER",
        verifiedToken: body.verifiedToken,
        ageAndTermsConfirmed: true,
      },
    });
    expect(signup.statusCode).toBe(201);
    const created = await prisma.user.findUniqueOrThrow({ where: { phone } });
    userIds.push(created.id);
    expect(created.termsVersion).toBe(TERMS_VERSION);
  });

  it("the sign-up token can't be used to log in", async () => {
    const phone = newPhone();
    await requestCode(phone);
    const { verifiedToken } = (await verifyCode(phone, otpService.codeFor(phone))).json();
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { phone, verifiedToken },
    });
    expect(login.statusCode).toBe(401);
  });

  it("a deleted account's number starts again as a new account", async () => {
    const user = await existingRider();
    const phone = user.phone;
    await deleteAccount(prisma, user.id);
    await requestCode(phone);
    const res = await verifyCode(phone, otpService.codeFor(phone));
    expect(res.json().status).toBe("newAccount");
  });

  it("answers the same for a registered and an unregistered number until the code is right", async () => {
    const user = await existingRider();
    const stranger = newPhone();

    const [sentA, sentB] = [await requestCode(user.phone), await requestCode(stranger)];
    expect([sentA.statusCode, sentA.json()]).toEqual([sentB.statusCode, sentB.json()]);

    const [wrongA, wrongB] = [
      await verifyCode(user.phone, "000000"),
      await verifyCode(stranger, "000000"),
    ];
    // A real code is never 000000 in tests' luck; guard against the 1-in-a-million anyway.
    if (otpService.codeFor(user.phone) !== "000000" && otpService.codeFor(stranger) !== "000000") {
      expect(wrongA.statusCode).toBe(400);
      expect(wrongB.statusCode).toBe(400);
      expect(wrongA.json().error.replace(user.phone, "PHONE")).toBe(
        wrongB.json().error.replace(stranger, "PHONE"),
      );
    }
  });

  it("a code is good once", async () => {
    const user = await existingRider();
    await requestCode(user.phone);
    const code = otpService.codeFor(user.phone);
    expect((await verifyCode(user.phone, code)).statusCode).toBe(200);
    expect((await verifyCode(user.phone, code)).statusCode).toBe(400);
  });

  it("keeps the per-number limit on checking codes", async () => {
    const phone = newPhone();
    await requestCode(phone);
    let last = 0;
    for (let i = 0; i <= RULES.otpVerify15m.max; i++) {
      last = (await verifyCode(phone, "000000")).statusCode;
    }
    expect(last).toBe(429);
  });

  it("takes a number typed any normal way", async () => {
    const user = await existingRider();
    const local = `0${user.phone.slice(4)}`;
    await requestCode(local);
    const res = await verifyCode(local, otpService.codeFor(user.phone));
    expect(res.json().status).toBe("signedIn");
  });

  it("refuses a malformed request", async () => {
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/auth/verify-code",
          payload: { phone: "0241234567" },
        })
      ).statusCode,
    ).toBe(400);
    expect((await verifyCode("12345", "123456")).statusCode).toBe(400);
  });
});

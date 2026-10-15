/**
 * Every normal way of typing a Ghana number works on every route that takes
 * one, and always becomes the same canonical +233XXXXXXXXX — including the
 * invisible characters phones and browsers add to a pasted or autofilled
 * number, which is what made the admin login refuse "0548617924" (2026-10).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "jsonwebtoken";
import { prisma } from "../db/prisma";
import { config, parsePhoneList } from "../config";
import { registerAllRoutes } from "./index";
import { DummyPaymentService } from "../services/payment/DummyPaymentService";
import { CapturingOtpService } from "../services/auth/testFixtures";
import { signAccessToken, signVerificationToken } from "../services/auth/tokens";
import { uniqueGhanaPhone } from "../test/testPhone";
import { setRateLimitStore } from "../rateLimit/limiter";
import { maskPhone } from "../services/auth/adminAccess";
import { MemoryRateLimitStore } from "../rateLimit/store";

/** The ways people write +233XXXXXXXXX, built from its 9 subscriber digits. */
function spellings(canonical: string): Record<string, string> {
  const s = canonical.slice(4); // 9 digits
  const local = `0${s}`;
  const [a, b, c] = [local.slice(0, 3), local.slice(3, 6), local.slice(6)];
  return {
    "local 0…": local,
    "+233…": canonical,
    "233…": canonical.slice(1),
    "00233…": `00${canonical.slice(1)}`,
    spaces: `${a} ${b} ${c}`,
    dashes: `${a}-${b}-${c}`,
    brackets: `(${a}) ${b} ${c}`,
    "spaces before and after": `   ${local}   `,
    "spaced +233": `+233 ${s.slice(0, 2)} ${s.slice(2, 5)} ${s.slice(5)}`,
    "+233 (0) …": `+233 (0) ${s.slice(0, 2)} ${s.slice(2, 5)} ${s.slice(5)}`,
    "non-breaking spaces": `${a}\u00A0${b}\u00A0${c}`,
    "copied with direction marks": `\u202A+233 ${s.slice(0, 2)} ${s.slice(2, 5)} ${s.slice(5)}\u202C`,
    "autofilled with a trailing mark": `${local}\u200E`,
  };
}

let app: FastifyInstance;
const otp = new CapturingOtpService();
const phones: string[] = [];
const userIds: string[] = [];

beforeAll(async () => {
  app = Fastify();
  registerAllRoutes(app, prisma, { otpService: otp, paymentService: new DummyPaymentService() });
  await app.ready();
});

afterAll(async () => {
  await prisma.otpCode.deleteMany({ where: { phone: { in: phones } } });
  // Admin-site attempts on numbers with no account are recorded under the masked number.
  await prisma.adminAuditLog.deleteMany({ where: { actor: "unknown", target: { in: phones.map(maskPhone) } } });
  await prisma.adminAuditLog.deleteMany({
    where: { OR: [{ actor: { in: userIds } }, { target: { in: userIds } }] },
  });
  await prisma.user.deleteMany({
    where: { OR: [{ id: { in: userIds } }, { phone: { in: phones } }] },
  });
  await app.close();
});

function newPhone(): string {
  const phone = uniqueGhanaPhone();
  phones.push(phone);
  return phone;
}

const post = (url: string, payload: object, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url, payload, headers });

/** Runs `check` once per spelling, each on a fresh number and fresh limits. */
async function forEverySpelling(
  check: (input: string, canonical: string, name: string) => Promise<void>,
) {
  for (const name of Object.keys(spellings("+233000000000"))) {
    setRateLimitStore(new MemoryRateLimitStore(10_000, 0));
    const canonical = newPhone();
    await check(spellings(canonical)[name]!, canonical, name);
  }
}

const ADMIN_SITE = { "x-campusride-client": "admin" };

describe("every spelling, on every login route", () => {
  for (const [client, headers] of [
    ["rider/driver apps", {}],
    ["admin site", ADMIN_SITE],
  ] as const) {
    it(`POST /auth/request-otp (${client}) stores the code under the canonical number`, async () => {
      await forEverySpelling(async (input, canonical, name) => {
        const res = await post("/auth/request-otp", { phone: input, purpose: "SIGNUP" }, headers);
        expect(res.statusCode, name).toBe(200);
        expect(await prisma.otpCode.count({ where: { phone: canonical } }), name).toBe(1);
      });
    });

    it(`POST /auth/verify-otp (${client}) verifies a code requested in any other spelling`, async () => {
      await forEverySpelling(async (input, canonical, name) => {
        await post("/auth/request-otp", { phone: canonical, purpose: "LOGIN" }, headers);
        const res = await post(
          "/auth/verify-otp",
          { phone: input, code: otp.codeFor(canonical), purpose: "LOGIN" },
          headers,
        );
        expect(res.statusCode, name).toBe(200);
        expect((jwt.decode(res.json().verifiedToken) as { phone: string }).phone, name).toBe(
          canonical,
        );
      });
    });
  }

  it("POST /auth/signup creates the account under the canonical number", async () => {
    await forEverySpelling(async (input, canonical, name) => {
      const res = await post("/auth/signup", {
        phone: input,
        name: "Ama",
        role: "RIDER",
        verifiedToken: signVerificationToken({ phone: canonical, purpose: "SIGNUP" }),
      });
      expect(res.statusCode, name).toBe(201);
      expect(res.json().user.phone, name).toBe(canonical);
      userIds.push(res.json().user.id);
    });
  });

  it("POST /auth/login finds the account, from the apps and the admin site", async () => {
    await forEverySpelling(async (input, canonical, name) => {
      const rider = await prisma.user.create({
        data: { phone: canonical, name: "Kofi", role: "RIDER" },
      });
      userIds.push(rider.id);
      const verifiedToken = signVerificationToken({ phone: canonical, purpose: "LOGIN" });
      const res = await post("/auth/login", { phone: input, verifiedToken });
      expect(res.statusCode, name).toBe(200);
      expect(res.json().user.id, name).toBe(rider.id);

      const admin = await prisma.user.update({ where: { id: rider.id }, data: { role: "ADMIN" } });
      const asAdmin = await post("/auth/login", { phone: input, verifiedToken }, ADMIN_SITE);
      expect(asAdmin.statusCode, name).toBe(200);
      expect(asAdmin.json().user.id, name).toBe(admin.id);
    });
  });

  it("one login can use a different spelling at each step", async () => {
    const canonical = newPhone();
    const s = spellings(canonical);
    expect(
      (await post("/auth/request-otp", { phone: s["local 0…"], purpose: "SIGNUP" }, ADMIN_SITE))
        .statusCode,
    ).toBe(200);
    const verify = await post("/auth/verify-otp", {
      phone: s["brackets"],
      code: otp.codeFor(canonical),
      purpose: "SIGNUP",
    });
    expect(verify.statusCode).toBe(200);
    const signup = await post("/auth/signup", {
      phone: s["copied with direction marks"],
      name: "Esi",
      role: "RIDER",
      verifiedToken: verify.json().verifiedToken,
    });
    expect(signup.statusCode).toBe(201);
    expect(signup.json().user.phone).toBe(canonical);
    userIds.push(signup.json().user.id);
  });

  it("still refuses what isn't a Ghana number, with the same message", async () => {
    for (const bad of [
      "054861792",
      "05486179245",
      "+15551234567",
      "+0548617924",
      "054861792a",
      "phone",
    ]) {
      const res = await post("/auth/request-otp", { phone: bad, purpose: "LOGIN" });
      expect(res.statusCode, bad).toBe(400);
      expect(res.json(), bad).toEqual({ error: "phone is not a valid Ghanaian number" });
    }
  });
});

describe("every spelling, everywhere else a number is taken", () => {
  it("ADMIN_PHONE_ALLOWLIST reads them all as the same number", () => {
    const canonical = "+233548617924";
    const list = parsePhoneList(Object.values(spellings(canonical)).join(", "));
    expect(list).toEqual({ phones: [canonical], invalid: [] });
  });

  it("the admin rate-limit lookup accepts any spelling", async () => {
    const admin = await prisma.user.create({
      data: { phone: newPhone(), name: "Admin", role: "ADMIN" },
    });
    userIds.push(admin.id);
    const token = signAccessToken({ userId: admin.id, role: "ADMIN" });
    const canonical = newPhone();
    for (const [name, input] of Object.entries(spellings(canonical))) {
      const res = await app.inject({
        method: "GET",
        url: `/admin/rate-limits?phone=${encodeURIComponent(input)}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode, name).toBe(200);
      expect(res.json().phone, name).toBe(canonical);
    }
  });

  it("an emergency contact may be pasted with invisible characters, which aren't stored", async () => {
    const rider = await prisma.user.create({
      data: { phone: newPhone(), name: "Abena", role: "RIDER" },
    });
    userIds.push(rider.id);
    const res = await app.inject({
      method: "PATCH",
      url: "/me",
      headers: { authorization: `Bearer ${signAccessToken({ userId: rider.id, role: "RIDER" })}` },
      payload: { emergencyContactName: "Auntie", emergencyContactPhone: "\u202A(024) 000-0111\u202C" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.emergencyContactPhone).toBe("(024) 000-0111");
  });

  it("is the same parser the apps use", async () => {
    const shared = await import("@rida/shared");
    const server = await import("../lib/phone");
    for (const input of Object.values(spellings("+233548617924"))) {
      expect(server.normalizePhone(input)).toBe(shared.normalizeGhanaPhone(input));
    }
    expect(config.adminPhoneAllowlist).toBeDefined();
  });
});

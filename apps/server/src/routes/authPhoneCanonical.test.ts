/**
 * Phone canonicalisation across the auth surface.
 *
 * The four auth endpoints all key on the phone string — OtpCode.phone,
 * User.phone, and the signed verification token that verifyVerificationToken
 * compares byte-for-byte. If they disagreed on spelling, a code requested as
 * "0548608146" could not be verified as "+233548608146", and a token minted by
 * one endpoint would be rejected by the next. These tests pin that a user can
 * move through the whole flow typing their number any way they like, and that
 * only the canonical form ever reaches the database.
 */
import { describe, it, expect, afterEach, afterAll, beforeAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { prisma } from "../db/prisma";
import { registerAuthRoutes } from "./auth";
import { CapturingOtpService } from "../services/auth/testFixtures";
import { OTP } from "../services/auth/constants";

let app: FastifyInstance;
let otpService: CapturingOtpService;
const createdPhones: string[] = [];

beforeAll(async () => {
  otpService = new CapturingOtpService();
  app = Fastify();
  registerAuthRoutes(app, prisma, otpService);
  await app.ready();
});

afterEach(async () => {
  while (createdPhones.length > 0) {
    const phone = createdPhones.pop()!;
    await prisma.user.deleteMany({ where: { phone } });
    await prisma.otpCode.deleteMany({ where: { phone } });
  }
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

/** Drives request-otp -> verify-otp, returning the verification token. */
async function verifiedToken(phoneAsTyped: string, canonical: string, purpose: "SIGNUP" | "LOGIN") {
  const requested = await app.inject({
    method: "POST",
    url: "/auth/request-otp",
    payload: { phone: phoneAsTyped, purpose },
  });
  expect(requested.statusCode).toBe(200);

  // The OTP row — and therefore the captured code — must be keyed on the
  // CANONICAL phone, not the string the caller typed.
  const row = await prisma.otpCode.findFirst({
    where: { phone: canonical, purpose, consumedAt: null },
    orderBy: { createdAt: "desc" },
  });
  expect(row, "OTP row should be stored under the canonical phone").not.toBeNull();

  const code = otpService.codeFor(canonical);

  const verified = await app.inject({
    method: "POST",
    url: "/auth/verify-otp",
    payload: { phone: phoneAsTyped, code, purpose },
  });
  return { verified, otpRow: row };
}

describe("OTP storage", () => {
  it("stores the OTP under the canonical phone whatever format was sent", async () => {
    const canonical = "+233548608161";
    createdPhones.push(canonical);

    const res = await app.inject({
      method: "POST",
      url: "/auth/request-otp",
      payload: { phone: "0548608161", purpose: "SIGNUP" },
    });

    expect(res.statusCode).toBe(200);
    expect(await prisma.otpCode.count({ where: { phone: canonical } })).toBe(1);
    expect(await prisma.otpCode.count({ where: { phone: "0548608161" } })).toBe(0);
  });

  /**
   * SECURITY, not just tidiness: the per-phone OTP caps in services/auth/otp.ts
   * count rows by exact phone string. Before canonicalisation an attacker (or
   * an impatient user) could reset the counter simply by re-spelling the
   * number — "0548…", "+233548…", "233548…" were three separate keys and each
   * got its own allowance. Now every spelling lands on one key, so the 4th
   * request is refused no matter how it is written.
   */
  it("applies the per-phone OTP cap across every equivalent spelling", async () => {
    const canonical = "+233548608162";
    createdPhones.push(canonical);

    const spellings = ["0548608162", "+233548608162", "233548608162", "054 860 8162"];
    const statuses: number[] = [];

    for (const form of spellings) {
      const res = await app.inject({
        method: "POST",
        url: "/auth/request-otp",
        payload: { phone: form, purpose: "SIGNUP" },
      });
      statuses.push(res.statusCode);
    }

    // The first OTP.OTP_MAX_SENDS_PER_15MIN succeed; the next is refused,
    // even though it is spelled differently from all the others.
    expect(statuses.slice(0, OTP.OTP_MAX_SENDS_PER_15MIN)).toEqual(
      new Array(OTP.OTP_MAX_SENDS_PER_15MIN).fill(200),
    );
    expect(statuses[OTP.OTP_MAX_SENDS_PER_15MIN]).toBe(429);

    // And every row that was written is keyed on the canonical spelling.
    expect(await prisma.otpCode.count({ where: { phone: canonical } })).toBe(
      OTP.OTP_MAX_SENDS_PER_15MIN,
    );
  });
});

describe("Signup", () => {
  it("stores the canonical phone when the user typed the local form", async () => {
    const canonical = "+233548608163";
    createdPhones.push(canonical);

    const { verified } = await verifiedToken("0548608163", canonical, "SIGNUP");
    expect(verified.statusCode).toBe(200);
    const { verifiedToken: token } = verified.json();

    const res = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { phone: "0548608163", name: "Local Typer", role: "RIDER", verifiedToken: token },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().user.phone).toBe(canonical);
    expect(await prisma.user.findUnique({ where: { phone: canonical } })).not.toBeNull();
  });

  /**
   * The cross-format case: request the code one way, sign up another. The
   * verification token is bound to the phone, so this only works because both
   * endpoints canonicalise before the token is minted and checked.
   */
  it("accepts a token requested in one format and used in another", async () => {
    const canonical = "+233548608164";
    createdPhones.push(canonical);

    const { verified } = await verifiedToken("233548608164", canonical, "SIGNUP");
    const { verifiedToken: token } = verified.json();

    const res = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { phone: "+233 548 608 164", name: "Format Mixer", role: "RIDER", verifiedToken: token },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().user.phone).toBe(canonical);
  });

  it("rejects a number that is not Ghanaian rather than storing it", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/request-otp",
      payload: { phone: "+15551234567", purpose: "SIGNUP" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("Ghanaian");
  });
});

describe("Login", () => {
  it("finds an account created in one format when logging in with another", async () => {
    const canonical = "+233548608165";
    createdPhones.push(canonical);

    const signupFlow = await verifiedToken("0548608165", canonical, "SIGNUP");
    await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: {
        phone: "0548608165",
        name: "Returning User",
        role: "RIDER",
        verifiedToken: signupFlow.verified.json().verifiedToken,
      },
    });

    // Now log in typing it completely differently.
    const loginFlow = await verifiedToken("233548608165", canonical, "LOGIN");
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { phone: "+233548608165", verifiedToken: loginFlow.verified.json().verifiedToken },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().user.phone).toBe(canonical);
  });
});

describe("The canonical-phone CHECK constraint", () => {
  it("refuses a non-canonical phone at the database level", async () => {
    // Belt and braces behind the route-level normalisation: even a direct
    // write cannot reintroduce a local-format row.
    await expect(
      prisma.user.create({ data: { phone: "0548608166", name: "Direct Write", role: "RIDER" } }),
    ).rejects.toThrow();
  });

  it("still allows the DELETE /me placeholder", async () => {
    // Without the 'deleted:%' arm of the constraint, account deletion breaks.
    const user = await prisma.user.create({
      data: { phone: "+233548608167", name: "To Delete", role: "RIDER" },
    });
    createdPhones.push("+233548608167");

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { phone: `deleted:${user.id}`, name: "Deleted user", deletedAt: new Date() },
    });
    expect(updated.phone).toBe(`deleted:${user.id}`);

    await prisma.user.deleteMany({ where: { id: user.id } });
  });
});

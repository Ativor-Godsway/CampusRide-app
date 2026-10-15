import { describe, it, expect, afterEach, afterAll } from "vitest";
import jwt from "jsonwebtoken";
import { prisma } from "../../db/prisma";
import { config } from "../../config";
import { requestOtp, verifyOtp } from "./otp";
import { OTP } from "./constants";
import { sha256 } from "./hash";
import { InvalidOtpError, OtpAttemptsExceededError, OtpExpiredError } from "./errors";
import { RateLimitedError } from "../../rateLimit/limiter";
import { RULES } from "../../rateLimit/rules";
import { CapturingOtpService, cleanupOtpCodes, uniqueTestPhone } from "./testFixtures";

const phones: string[] = [];

afterEach(async () => {
  while (phones.length > 0) {
    await cleanupOtpCodes(phones.pop()!);
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

function newPhone(): string {
  const phone = uniqueTestPhone();
  phones.push(phone);
  return phone;
}

describe("requestOtp", () => {
  it("generates a 6-digit code, stores its sha256 hash, and sends it via OtpService", async () => {
    const phone = newPhone();
    const otpService = new CapturingOtpService();

    await requestOtp(prisma, otpService, phone, "SIGNUP");

    const code = otpService.codeFor(phone);
    expect(code).toMatch(/^\d{6}$/);

    const stored = await prisma.otpCode.findFirst({ where: { phone, purpose: "SIGNUP" } });
    expect(stored).not.toBeNull();
    expect(stored!.codeHash).toBe(sha256(code));
    expect(stored!.codeHash).not.toBe(code);
    expect(stored!.consumedAt).toBeNull();
    expect(stored!.attemptCount).toBe(0);
  });

  it("refuses a number past its cooldown allowance, without sending, and allows it again after", async () => {
    const phone = newPhone();
    const otpService = new CapturingOtpService();
    const now = new Date("2026-01-01T00:00:00Z");

    for (let i = 0; i < RULES.otpCooldown.max; i++) {
      await requestOtp(prisma, otpService, phone, "LOGIN", now);
    }
    const before = await prisma.otpCode.count({ where: { phone } });
    const refused = requestOtp(prisma, otpService, phone, "LOGIN", now);
    await expect(refused).rejects.toThrow(RateLimitedError);
    await expect(refused).rejects.toMatchObject({ rule: RULES.otpCooldown });
    expect(await prisma.otpCode.count({ where: { phone } })).toBe(before);

    const later = new Date(now.getTime() + RULES.otpCooldown.windowMs + 1);
    await expect(requestOtp(prisma, otpService, phone, "LOGIN", later)).resolves.toBeUndefined();
  });

  it("gives an admin's number the stricter 15-minute cap", async () => {
    const adminPhone = newPhone();
    const riderPhone = newPhone();
    const admin = await prisma.user.create({ data: { phone: adminPhone, name: "Admin", role: "ADMIN" } });
    const otpService = new CapturingOtpService();
    const t0 = new Date("2026-01-02T00:00:00Z").getTime();

    // Sends at the cooldown's pace until the admin cap is reached.
    let sent = 0;
    for (let minute = 0; sent < RULES.adminOtpSend15m.max; minute++) {
      const at = new Date(t0 + minute * (RULES.otpCooldown.windowMs + 1));
      for (let i = 0; i < RULES.otpCooldown.max && sent < RULES.adminOtpSend15m.max; i++, sent++) {
        await requestOtp(prisma, otpService, adminPhone, "LOGIN", at);
        await requestOtp(prisma, otpService, riderPhone, "LOGIN", at);
      }
    }
    const next = new Date(t0 + 10 * (RULES.otpCooldown.windowMs + 1));
    await expect(requestOtp(prisma, otpService, adminPhone, "LOGIN", next)).rejects.toMatchObject({
      rule: RULES.adminOtpSend15m,
    });
    // The same count on an ordinary number is still allowed.
    await expect(requestOtp(prisma, otpService, riderPhone, "LOGIN", next)).resolves.toBeUndefined();
    await prisma.user.delete({ where: { id: admin.id } });
  });
});

describe("verifyOtp", () => {
  it("succeeds with the correct code and returns a verifiedToken", async () => {
    const phone = newPhone();
    const otpService = new CapturingOtpService();
    await requestOtp(prisma, otpService, phone, "SIGNUP");
    const code = otpService.codeFor(phone);

    const result = await verifyOtp(prisma, phone, code, "SIGNUP");
    expect(result.verifiedToken).toEqual(expect.any(String));

    const decoded = jwt.verify(result.verifiedToken, config.jwtSecret) as {
      phone: string;
      purpose: string;
    };
    expect(decoded.phone).toBe(phone);
    expect(decoded.purpose).toBe("SIGNUP");

    const stored = await prisma.otpCode.findFirst({ where: { phone, purpose: "SIGNUP" } });
    expect(stored!.consumedAt).not.toBeNull();
  });

  it("fails with the wrong code and increments attemptCount", async () => {
    const phone = newPhone();
    const otpService = new CapturingOtpService();
    await requestOtp(prisma, otpService, phone, "SIGNUP");

    await expect(verifyOtp(prisma, phone, "000000", "SIGNUP")).rejects.toThrow(InvalidOtpError);

    const stored = await prisma.otpCode.findFirst({ where: { phone, purpose: "SIGNUP" } });
    expect(stored!.attemptCount).toBe(1);
    expect(stored!.consumedAt).toBeNull();
  });

  it("fails when there is no matching unconsumed OTP", async () => {
    const phone = newPhone();
    await expect(verifyOtp(prisma, phone, "123456", "SIGNUP")).rejects.toThrow(InvalidOtpError);
  });

  it("fails when the code has expired", async () => {
    const phone = newPhone();
    const otpService = new CapturingOtpService();
    const now = new Date("2026-01-01T00:00:00Z");
    await requestOtp(prisma, otpService, phone, "SIGNUP", now);
    const code = otpService.codeFor(phone);

    const afterExpiry = new Date(now.getTime() + (OTP.OTP_TTL_MINUTES + 1) * 60_000);
    await expect(verifyOtp(prisma, phone, code, "SIGNUP", afterExpiry)).rejects.toThrow(
      OtpExpiredError,
    );
  });

  it("rejects reuse of an already-consumed code", async () => {
    const phone = newPhone();
    const otpService = new CapturingOtpService();
    await requestOtp(prisma, otpService, phone, "SIGNUP");
    const code = otpService.codeFor(phone);

    await verifyOtp(prisma, phone, code, "SIGNUP");
    await expect(verifyOtp(prisma, phone, code, "SIGNUP")).rejects.toThrow(InvalidOtpError);
  });

  it("invalidates the OTP once max verify attempts are exceeded", async () => {
    const phone = newPhone();
    const otpService = new CapturingOtpService();
    await requestOtp(prisma, otpService, phone, "SIGNUP");
    const code = otpService.codeFor(phone);

    for (let i = 0; i < OTP.OTP_MAX_VERIFY_ATTEMPTS - 1; i++) {
      await expect(verifyOtp(prisma, phone, "000000", "SIGNUP")).rejects.toThrow(InvalidOtpError);
    }

    // This attempt pushes attemptCount to OTP_MAX_VERIFY_ATTEMPTS -> invalidated.
    await expect(verifyOtp(prisma, phone, "000000", "SIGNUP")).rejects.toThrow(
      OtpAttemptsExceededError,
    );

    // Even the correct code is now rejected — the OTP was consumed/invalidated.
    await expect(verifyOtp(prisma, phone, code, "SIGNUP")).rejects.toThrow(InvalidOtpError);
  });
});

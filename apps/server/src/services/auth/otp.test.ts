import { describe, it, expect, afterEach, afterAll } from "vitest";
import jwt from "jsonwebtoken";
import { prisma } from "../../db/prisma";
import { config } from "../../config";
import { requestOtp, verifyOtp } from "./otp";
import { OTP } from "./constants";
import { sha256 } from "./hash";
import {
  InvalidOtpError,
  OtpAttemptsExceededError,
  OtpExpiredError,
  OtpRateLimitExceededError,
} from "./errors";
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

  it("rejects the 4th send within a 15-minute window", async () => {
    const phone = newPhone();
    const otpService = new CapturingOtpService();
    const now = new Date("2026-01-01T00:00:00Z");

    for (let i = 0; i < OTP.OTP_MAX_SENDS_PER_15MIN; i++) {
      await requestOtp(prisma, otpService, phone, "LOGIN", now);
    }

    await expect(requestOtp(prisma, otpService, phone, "LOGIN", now)).rejects.toThrow(
      OtpRateLimitExceededError,
    );
  });

  it("rejects the 6th send within a 1-hour window even though the 15-min limit never trips", async () => {
    const phone = newPhone();
    const otpService = new CapturingOtpService();
    const base = new Date("2026-01-01T00:00:00Z");

    // 5 sends spaced 12 minutes apart: each 15-min lookback only ever sees
    // the immediately preceding send (count=1 < 3), but the 1-hour lookback
    // for the 6th send (at +60min) sees all 5 prior sends (count=5 >= 5).
    for (let i = 0; i < OTP.OTP_MAX_SENDS_PER_HOUR; i++) {
      const now = new Date(base.getTime() + i * 12 * 60_000);
      await requestOtp(prisma, otpService, phone, "LOGIN", now);
    }

    const sixth = new Date(base.getTime() + OTP.OTP_MAX_SENDS_PER_HOUR * 12 * 60_000);
    await expect(requestOtp(prisma, otpService, phone, "LOGIN", sixth)).rejects.toThrow(
      OtpRateLimitExceededError,
    );
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

import type { OtpPurpose, PrismaClient } from "@prisma/client";
import type { OtpService } from "../otp/OtpService";
import { OTP } from "./constants";
import { generateOtpCode, sha256 } from "./hash";
import {
  InvalidOtpError,
  OtpAttemptsExceededError,
  OtpExpiredError,
  OtpRateLimitExceededError,
} from "./errors";
import { signVerificationToken } from "./tokens";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * Generates and sends an OTP for `phone`/`purpose`, enforcing the rolling
 * 15-minute and 1-hour send-rate limits. Stores only the sha256 hash of the
 * code. `now` is injectable for deterministic rate-limit tests.
 */
export async function requestOtp(
  prisma: PrismaClient,
  otpService: OtpService,
  phone: string,
  purpose: OtpPurpose,
  now: Date = new Date(),
): Promise<void> {
  const fifteenMinAgo = new Date(now.getTime() - 15 * MINUTE_MS);
  const oneHourAgo = new Date(now.getTime() - HOUR_MS);

  const [recentCount, hourlyCount] = await Promise.all([
    prisma.otpCode.count({
      where: { phone, createdAt: { gte: fifteenMinAgo } },
    }),
    prisma.otpCode.count({
      where: { phone, createdAt: { gte: oneHourAgo } },
    }),
  ]);

  if (recentCount >= OTP.OTP_MAX_SENDS_PER_15MIN) {
    throw new OtpRateLimitExceededError(phone, "15min");
  }
  if (hourlyCount >= OTP.OTP_MAX_SENDS_PER_HOUR) {
    throw new OtpRateLimitExceededError(phone, "1hour");
  }

  const code = generateOtpCode();
  const codeHash = sha256(code);
  const expiresAt = new Date(now.getTime() + OTP.OTP_TTL_MINUTES * MINUTE_MS);

  await prisma.otpCode.create({
    data: { phone, codeHash, purpose, expiresAt, createdAt: now },
  });

  await otpService.sendOtp(phone, code);
}

export interface VerifyOtpResult {
  /**
   * Short-lived signed token proving `phone` was just verified for
   * `purpose`. Consumed by /auth/signup or /auth/login.
   */
  verifiedToken: string;
}

/**
 * Verifies the most recent unconsumed OTP for `phone`/`purpose`.
 *
 * - No matching OTP at all -> InvalidOtpError.
 * - Matching OTP but expired -> OtpExpiredError (left consumable so a fresh
 *   request can supersede it; it will simply expire out of future lookups).
 * - Wrong code -> increments attemptCount; once attemptCount reaches
 *   OTP_MAX_VERIFY_ATTEMPTS the OTP is consumed (invalidated) and
 *   OtpAttemptsExceededError is thrown instead of InvalidOtpError.
 * - Correct code -> marks the OTP consumed and returns a verifiedToken.
 */
export async function verifyOtp(
  prisma: PrismaClient,
  phone: string,
  code: string,
  purpose: OtpPurpose,
  now: Date = new Date(),
): Promise<VerifyOtpResult> {
  const otp = await prisma.otpCode.findFirst({
    where: { phone, purpose, consumedAt: null },
    orderBy: { createdAt: "desc" },
  });

  if (!otp) {
    throw new InvalidOtpError(phone);
  }

  if (otp.expiresAt < now) {
    throw new OtpExpiredError(phone);
  }

  const codeHash = sha256(code);

  if (codeHash !== otp.codeHash) {
    const attemptCount = otp.attemptCount + 1;
    const exceeded = attemptCount >= OTP.OTP_MAX_VERIFY_ATTEMPTS;

    await prisma.otpCode.update({
      where: { id: otp.id },
      data: {
        attemptCount,
        consumedAt: exceeded ? now : null,
      },
    });

    if (exceeded) {
      throw new OtpAttemptsExceededError(phone);
    }
    throw new InvalidOtpError(phone);
  }

  await prisma.otpCode.update({
    where: { id: otp.id },
    data: { consumedAt: now },
  });

  return { verifiedToken: signVerificationToken({ phone, purpose }) };
}

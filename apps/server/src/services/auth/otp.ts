import type { OtpPurpose, PrismaClient } from "@prisma/client";
import type { OtpService } from "../otp/OtpService";
import { OTP } from "./constants";
import { generateOtpCode, sha256 } from "./hash";
import { loadTestOtpCode } from "./loadTestOtp";
import { reviewDemoCodeFor } from "../reviewDemo/accounts";
import { InvalidOtpError, OtpAttemptsExceededError, OtpExpiredError } from "./errors";
import { signVerificationToken } from "./tokens";
import { enforce, type LimitCheck } from "../../rateLimit/limiter";
import { RULES } from "../../rateLimit/rules";

const MINUTE_MS = 60_000;

/** Null everywhere but a local load test (./loadTestOtp.ts). */
const LOAD_TEST_CODE = loadTestOtpCode();

/**
 * Whether `phone` belongs to an ADMIN account: its codes get the stricter
 * limits. Decided by the number, not by which app asked, so the admin site's
 * limits can't be dodged by asking through the rider app.
 */
async function isAdminPhone(prisma: PrismaClient, phone: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { phone }, select: { role: true, deletedAt: true } });
  return user?.role === "ADMIN" && !user.deletedAt;
}

export interface RequestOtpOptions {
  /** The requester's IP when known: counts toward the per-IP send backstop. */
  ip?: string | null;
  /** How long the code stays valid; OTP.OTP_TTL_MINUTES unless given. */
  ttlMinutes?: number;
  /** The whole text message, built around the code; the provider's usual wording unless given. */
  message?: (code: string) => string;
}

/**
 * Generates and sends an OTP for `phone`/`purpose`. Stores only the sha256
 * hash of the code.
 *
 * Limits, per NUMBER (never per IP — a hostel shares one): one code per
 * cooldown, and caps per 15 minutes and per 24 hours, stricter for an admin's
 * number; plus a generous per-IP cap on codes to ANY numbers, so one machine
 * can't text all of Ghana on our SMS credit. Throws RateLimitedError, and
 * nothing is sent, when any of them refuses. `now` is injectable for tests.
 */
export async function requestOtp(
  prisma: PrismaClient,
  otpService: OtpService,
  phone: string,
  purpose: OtpPurpose,
  now: Date = new Date(),
  options: RequestOtpOptions = {},
): Promise<void> {
  const admin = await isAdminPhone(prisma, phone);
  const checks: LimitCheck[] = [
    { rule: RULES.otpCooldown, subject: phone },
    { rule: admin ? RULES.adminOtpSend15m : RULES.otpSend15m, subject: phone },
    { rule: admin ? RULES.adminOtpSend24h : RULES.otpSend24h, subject: phone },
  ];
  if (options.ip) checks.push({ rule: RULES.ipOtpSend, subject: options.ip });
  await enforce(checks, now.getTime());

  // The two App Store / Google Play review numbers get the fixed review code
  // and no SMS (services/reviewDemo); every other number a random code by SMS.
  // The limits above apply to them all the same.
  const demoCode = await reviewDemoCodeFor(prisma, phone);
  const code = demoCode ?? LOAD_TEST_CODE ?? generateOtpCode();
  const codeHash = sha256(code);
  const expiresAt = new Date(now.getTime() + (options.ttlMinutes ?? OTP.OTP_TTL_MINUTES) * MINUTE_MS);

  await prisma.otpCode.create({
    data: { phone, codeHash, purpose, expiresAt, createdAt: now },
  });

  if (demoCode) return;
  await otpService.sendOtp(phone, code, options.message?.(code));
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
 * Every check counts toward the number's verify limit (stricter for an
 * admin's number) before anything is looked at; past it, RateLimitedError.
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
  const admin = await isAdminPhone(prisma, phone);
  await enforce([{ rule: admin ? RULES.adminOtpVerify15m : RULES.otpVerify15m, subject: phone }], now.getTime());

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

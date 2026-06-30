import { createHash, randomInt } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { OtpService } from "../otp/OtpService";
import { normalizePhone } from "../../lib/phone";

/**
 * Showcase-demo OTP store + abuse protection, fully isolated from the real
 * auth OTP flow (separate DemoOtp table, separate /demo/* routes). This is a
 * PUBLIC, unauthenticated, abusable surface — every send spends real Moolre
 * SMS credit — so rate limiting here is load-bearing, not decorative.
 *
 * Delivery reuses the proven Moolre SMS path via the injected OtpService
 * (MoolreOtpService in prod → /open/sms/send + CampusRide sender ID). No
 * payment / Collections code is touched.
 *
 * All windowed counters (per-phone/day, per-IP/hour, global/day) are counted
 * from the DemoOtp table so they survive process restarts; rows are swept
 * after `retentionHours` to keep the table tiny while still covering the
 * longest rate-limit window. Codes are stored only as sha256 hashes.
 */

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

export interface DemoOtpLimits {
  /** Code validity window. */
  ttlMinutes: number;
  /** Number of digits in the generated code. */
  codeLength: number;
  /** Max wrong verify attempts before the code is invalidated (forces re-send). */
  maxVerifyAttempts: number;
  /** Min gap between sends to the same phone (e.g. 60 → max 1 / minute). */
  perPhoneMinIntervalSeconds: number;
  /** Max sends to one phone in a rolling 24h. */
  perPhoneMaxPerDay: number;
  /** Max sends from one IP in a rolling hour. */
  perIpMaxPerHour: number;
  /** Global cap over a rolling 24h — protects the Moolre SMS balance. */
  globalMaxPerDay: number;
  /** How long rows are retained for rate-limit counting before being swept. */
  retentionHours: number;
}

export interface DemoOtpDeps {
  prisma: PrismaClient;
  otpService: OtpService;
  limits: DemoOtpLimits;
  /** Injectable clock for deterministic tests. */
  now?: Date;
}

export type DemoOtpSendResult =
  | { ok: true }
  | { ok: false; status: 400 | 429 | 502; reason: string };

export type DemoOtpVerifyResult = { ok: true } | { ok: false; status: 400; reason: string };

/** sha256 hex — never store or return the raw code. */
function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/** Cryptographically-random zero-padded numeric code of the given length. */
function generateCode(length: number): string {
  return randomInt(0, 10 ** length)
    .toString()
    .padStart(length, "0");
}

/**
 * Normalizes input to the demo's two needed forms, or null if it isn't a
 * plausible Ghanaian mobile number:
 *   - `local`: leading-0 form ("0594826328") — the stored/looked-up key.
 *   - `msisdnPlus`: "+233…" — handed to the SMS service (it strips "+" → "233…").
 */
export function normalizeDemoPhone(
  input: string,
): { local: string; msisdnPlus: string } | null {
  const canonical = normalizePhone(input); // "+233XXXXXXXXX" or null (validates)
  if (!canonical) return null;
  const subscriber = canonical.slice(4); // 9 digits after "+233"
  return { local: `0${subscriber}`, msisdnPlus: canonical };
}

/**
 * Generate + store + send a demo OTP, enforcing per-phone, per-IP and global
 * rate limits. Returns a discriminated result the route maps to a status code
 * — never throws for the expected (validation / rate-limit) cases.
 */
export async function requestDemoOtp(
  deps: DemoOtpDeps,
  args: { phone: string; ip: string | null },
): Promise<DemoOtpSendResult> {
  const { prisma, otpService, limits } = deps;
  const now = deps.now ?? new Date();

  const normalized = normalizeDemoPhone(args.phone);
  if (!normalized) {
    return { ok: false, status: 400, reason: "Enter a valid Ghana mobile number." };
  }
  const { local, msisdnPlus } = normalized;

  // Sweep rows older than the longest rate-limit window — keeps the table tiny
  // without a cron. Best-effort: never block a send on cleanup.
  await prisma.demoOtp
    .deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - limits.retentionHours * HOUR_MS) } } })
    .catch(() => undefined);

  // ── Rate limits (counted from the table; cheapest/most-specific first) ──
  const sinceMinute = new Date(now.getTime() - limits.perPhoneMinIntervalSeconds * SECOND_MS);
  const sinceHour = new Date(now.getTime() - HOUR_MS);
  const sinceDay = new Date(now.getTime() - 24 * HOUR_MS);

  const recentForPhone = await prisma.demoOtp.count({
    where: { phone: local, createdAt: { gte: sinceMinute } },
  });
  if (recentForPhone > 0) {
    return {
      ok: false,
      status: 429,
      reason: "Please wait a moment before requesting another code.",
    };
  }

  const dailyForPhone = await prisma.demoOtp.count({
    where: { phone: local, createdAt: { gte: sinceDay } },
  });
  if (dailyForPhone >= limits.perPhoneMaxPerDay) {
    return {
      ok: false,
      status: 429,
      reason: "You've requested too many codes today. Please try again tomorrow.",
    };
  }

  if (args.ip) {
    const hourlyForIp = await prisma.demoOtp.count({
      where: { ip: args.ip, createdAt: { gte: sinceHour } },
    });
    if (hourlyForIp >= limits.perIpMaxPerHour) {
      return {
        ok: false,
        status: 429,
        reason: "Too many requests from your network. Please try again later.",
      };
    }
  }

  const globalDaily = await prisma.demoOtp.count({
    where: { createdAt: { gte: sinceDay } },
  });
  if (globalDaily >= limits.globalMaxPerDay) {
    return {
      ok: false,
      status: 429,
      reason: "The live demo is very busy right now — please try again later.",
    };
  }

  // ── Generate, store (hash only), then send ──
  const code = generateCode(limits.codeLength);
  const expiresAt = new Date(now.getTime() + limits.ttlMinutes * MINUTE_MS);

  const row = await prisma.demoOtp.create({
    data: { phone: local, codeHash: hashCode(code), ip: args.ip, expiresAt, createdAt: now },
  });

  const result = await otpService.sendOtp(msisdnPlus, code);
  if (!result.success) {
    // Don't let a failed send count against the caller's limits.
    await prisma.demoOtp.delete({ where: { id: row.id } }).catch(() => undefined);
    return { ok: false, status: 502, reason: "Couldn't send the code right now. Please try again." };
  }

  return { ok: true };
}

/**
 * Verify a submitted code against the most recent active row for the phone.
 * Deletes the row on success or once the attempt cap is hit (forcing a fresh
 * send). Returns a discriminated result; the route maps failures to 4xx.
 */
export async function verifyDemoOtp(
  deps: DemoOtpDeps,
  args: { phone: string; code: string },
): Promise<DemoOtpVerifyResult> {
  const { prisma, limits } = deps;
  const now = deps.now ?? new Date();

  const normalized = normalizeDemoPhone(args.phone);
  if (!normalized) {
    return { ok: false, status: 400, reason: "Enter a valid Ghana mobile number." };
  }

  const row = await prisma.demoOtp.findFirst({
    where: { phone: normalized.local },
    orderBy: { createdAt: "desc" },
  });

  if (!row) {
    return { ok: false, status: 400, reason: "No active code — request a new one." };
  }

  if (row.expiresAt < now) {
    await prisma.demoOtp.delete({ where: { id: row.id } }).catch(() => undefined);
    return { ok: false, status: 400, reason: "That code has expired — request a new one." };
  }

  if (hashCode(args.code) !== row.codeHash) {
    const attempts = row.attempts + 1;
    if (attempts >= limits.maxVerifyAttempts) {
      await prisma.demoOtp.delete({ where: { id: row.id } }).catch(() => undefined);
      return {
        ok: false,
        status: 400,
        reason: "Too many incorrect attempts — request a new code.",
      };
    }
    await prisma.demoOtp.update({ where: { id: row.id }, data: { attempts } });
    return { ok: false, status: 400, reason: "Incorrect code." };
  }

  // Correct — invalidate so the code is single-use.
  await prisma.demoOtp.delete({ where: { id: row.id } }).catch(() => undefined);
  return { ok: true };
}

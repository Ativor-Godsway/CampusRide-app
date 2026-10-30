import { describe, expect, it } from "vitest";
import {
  OTP_RESEND_COOLDOWN_SECONDS,
  formatCountdown,
  rateLimitMessage,
  rateLimitedBody,
  retryAfterSecondsOf,
  retryAfterText,
  OTP_COOLDOWN_LIMIT,
  isOtpCooldown,
  otpCooldownMessage,
} from "./rateLimit";

describe("retryAfterText", () => {
  it("speaks in seconds, minutes, then hours, always rounding up", () => {
    expect(retryAfterText(0)).toBe("1 second");
    expect(retryAfterText(1)).toBe("1 second");
    expect(retryAfterText(45)).toBe("45 seconds");
    expect(retryAfterText(60)).toBe("1 minute");
    expect(retryAfterText(61)).toBe("2 minutes");
    expect(retryAfterText(14 * 60 + 1)).toBe("15 minutes");
    expect(retryAfterText(89 * 60)).toBe("89 minutes");
    expect(retryAfterText(2 * 3600)).toBe("about 2 hours");
    expect(retryAfterText(23.5 * 3600)).toBe("about 24 hours");
  });
});

describe("rateLimitedBody", () => {
  it("is the friendly sentence plus whole seconds", () => {
    expect(rateLimitedBody(179.2)).toEqual({
      error: "Too many attempts. Try again in 3 minutes.",
      code: "RATE_LIMITED",
      retryAfterSeconds: 180,
    });
    expect(rateLimitMessage(30)).toBe("Too many attempts. Try again in 30 seconds.");
  });
});

describe("retryAfterSecondsOf", () => {
  const err = (status: number, data?: unknown, headers?: Record<string, unknown>) => ({
    response: { status, data, headers },
  });

  it("reads the body, then the header, and is null for anything but a 429", () => {
    expect(retryAfterSecondsOf(err(429, { retryAfterSeconds: 42 }))).toBe(42);
    expect(retryAfterSecondsOf(err(429, {}, { "retry-after": "90" }))).toBe(90);
    expect(retryAfterSecondsOf(err(429, {}, {}))).toBe(60);
    expect(retryAfterSecondsOf(err(400, { retryAfterSeconds: 42 }))).toBeNull();
    expect(retryAfterSecondsOf(new Error("offline"))).toBeNull();
    expect(retryAfterSecondsOf(null)).toBeNull();
  });
});

describe("formatCountdown", () => {
  it("shows m:ss, or h:mm:ss past an hour", () => {
    expect(formatCountdown(OTP_RESEND_COOLDOWN_SECONDS)).toBe("1:00");
    expect(formatCountdown(42)).toBe("0:42");
    expect(formatCountdown(599.2)).toBe("10:00");
    expect(formatCountdown(3725)).toBe("1:02:05");
    expect(formatCountdown(-3)).toBe("0:00");
  });
});

describe("the one-code-a-minute cooldown", () => {
  it("says how long to wait, as a countdown, not as a limit reached", () => {
    expect(otpCooldownMessage(45)).toBe("Wait 0:45 before asking for a new code.");
    expect(otpCooldownMessage(59.2)).toBe("Wait 1:00 before asking for a new code.");
    expect(otpCooldownMessage(0)).toBe("Wait 0:01 before asking for a new code.");
  });

  it("is told apart from every other 429 by the body's limit", () => {
    const err = (status: number, data: unknown) => ({ response: { status, data } });
    expect(isOtpCooldown(err(429, { code: "RATE_LIMITED", limit: OTP_COOLDOWN_LIMIT }))).toBe(true);
    expect(isOtpCooldown(err(429, { code: "RATE_LIMITED" }))).toBe(false);
    expect(isOtpCooldown(err(400, { limit: OTP_COOLDOWN_LIMIT }))).toBe(false);
    expect(isOtpCooldown(new Error("timeout"))).toBe(false);
    expect(isOtpCooldown(null)).toBe(false);
  });
});

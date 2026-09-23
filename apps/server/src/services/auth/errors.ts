/**
 * Typed errors for the auth service. Routes map these to HTTP status codes
 * (see routes/auth.ts).
 */

/** Thrown by requestOtp when a phone has hit the 15-min or 1-hour send limit. */
export class OtpRateLimitExceededError extends Error {
  readonly phone: string;
  readonly window: "15min" | "1hour";

  constructor(phone: string, window: "15min" | "1hour") {
    super(`OTP send rate limit exceeded for ${phone} (${window} window)`);
    this.name = "OtpRateLimitExceededError";
    this.phone = phone;
    this.window = window;
  }
}

/**
 * Thrown by verifyOtp when there is no matching unconsumed OTP, the code is
 * wrong, or the OTP has just been invalidated by exceeding max attempts.
 */
export class InvalidOtpError extends Error {
  readonly phone: string;

  constructor(phone: string) {
    super(`Invalid or missing OTP for ${phone}`);
    this.name = "InvalidOtpError";
    this.phone = phone;
  }
}

/** Thrown by verifyOtp when the matching OTP has expired. */
export class OtpExpiredError extends Error {
  readonly phone: string;

  constructor(phone: string) {
    super(`OTP for ${phone} has expired`);
    this.name = "OtpExpiredError";
    this.phone = phone;
  }
}

/**
 * Thrown by verifyOtp when this attempt pushes attemptCount past
 * OTP_MAX_VERIFY_ATTEMPTS — the OTP is invalidated as part of throwing this.
 */
export class OtpAttemptsExceededError extends Error {
  readonly phone: string;

  constructor(phone: string) {
    super(`Too many incorrect attempts for ${phone}'s OTP — request a new code`);
    this.name = "OtpAttemptsExceededError";
    this.phone = phone;
  }
}

/** Thrown by signup when the phone is already registered. */
export class PhoneAlreadyRegisteredError extends Error {
  readonly phone: string;

  constructor(phone: string) {
    super(`Phone ${phone} is already registered`);
    this.name = "PhoneAlreadyRegisteredError";
    this.phone = phone;
  }
}

/** Thrown by login when no user exists for the given phone. */
export class UserNotFoundError extends Error {
  readonly phone: string;

  constructor(phone: string) {
    super(`No account found for ${phone} — please sign up first`);
    this.name = "UserNotFoundError";
    this.phone = phone;
  }
}

/** Thrown by refresh/logout when the refresh token is missing, revoked, or expired. */
export class InvalidRefreshTokenError extends Error {
  constructor() {
    super("Refresh token is invalid, revoked, or expired");
    this.name = "InvalidRefreshTokenError";
  }
}

/**
 * Thrown when an ALREADY-CONSUMED refresh token is presented again. Because
 * every successful refresh revokes the token it rotated out, a second use of
 * that same token means a copy is in circulation — the legitimate client and
 * an attacker cannot both hold a live copy of a one-time token. The whole
 * rotation family is revoked before this is thrown.
 *
 * Extends InvalidRefreshTokenError so existing callers keep their behaviour
 * (the route must answer identically either way — telling an attacker that
 * their stolen token was detected is free intelligence). It exists as a
 * distinct type purely so the server can LOG the theft signal.
 */
export class RefreshTokenReuseError extends InvalidRefreshTokenError {
  constructor(public readonly userId: string) {
    super();
    this.name = "RefreshTokenReuseError";
  }
}

/**
 * Thrown when a short-lived verification token (issued by /auth/verify-otp)
 * is missing, malformed, expired, or for the wrong purpose.
 */
export class InvalidVerificationTokenError extends Error {
  constructor() {
    super("Verification token is invalid, expired, or for the wrong purpose");
    this.name = "InvalidVerificationTokenError";
  }
}

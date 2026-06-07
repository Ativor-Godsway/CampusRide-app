/**
 * CampusRide auth constants — named, never magic numbers inline.
 */

export const OTP = {
  /** Number of digits in a generated OTP code. */
  OTP_LENGTH: 6,
  /** How long an OTP code is valid for after being sent. */
  OTP_TTL_MINUTES: 5,
  /** Max OTP sends to a single phone within a rolling 15-minute window. */
  OTP_MAX_SENDS_PER_15MIN: 3,
  /** Max OTP sends to a single phone within a rolling 1-hour window. */
  OTP_MAX_SENDS_PER_HOUR: 5,
  /** Max verify attempts per OTP before it is invalidated. */
  OTP_MAX_VERIFY_ATTEMPTS: 5,
} as const;

export const TOKEN = {
  /** Access token lifetime, in minutes. */
  ACCESS_TOKEN_TTL_MINUTES: 30,
  /** Refresh token lifetime, in days. */
  REFRESH_TOKEN_TTL_DAYS: 30,
  /**
   * Lifetime of the short-lived "verification token" issued by
   * /auth/verify-otp and consumed by /auth/signup or /auth/login. Matches
   * the OTP TTL so the whole signup/login round trip has one consistent
   * time budget.
   */
  VERIFICATION_TOKEN_TTL_MINUTES: OTP.OTP_TTL_MINUTES,
} as const;

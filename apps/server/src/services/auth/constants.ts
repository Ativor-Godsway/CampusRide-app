/**
 * CampusRide auth constants — named, never magic numbers inline.
 */

export const OTP = {
  /** Number of digits in a generated OTP code. */
  OTP_LENGTH: 6,
  /** How long an OTP code is valid for after being sent. */
  OTP_TTL_MINUTES: 5,
  // How often a number may be sent a code, or check one, is a rate limit:
  // see src/rateLimit/rules.ts (otp.*).
  /** Max verify attempts per OTP before it is invalidated. */
  OTP_MAX_VERIFY_ATTEMPTS: 5,
} as const;

export const TOKEN = {
  /** Access token lifetime, in minutes. */
  ACCESS_TOKEN_TTL_MINUTES: 30,
  /** Refresh token lifetime, in days. */
  REFRESH_TOKEN_TTL_DAYS: 30,
  /**
   * How long a just-rotated refresh token may be presented again as a RETRY
   * (authService.refresh). A phone on a bad connection can send a refresh
   * that the server completes but whose answer never arrives; the phone
   * still holds the old token and sends it again once it is back online.
   * Inside this window that is honoured, and the user stays signed in;
   * after it, presenting a used token is treated as theft.
   */
  REFRESH_RETRY_GRACE_MINUTES: 10,
  /**
   * Lifetime of the short-lived "verification token" issued by
   * /auth/verify-otp and consumed by /auth/signup or /auth/login. Matches
   * the OTP TTL so the whole signup/login round trip has one consistent
   * time budget.
   */
  VERIFICATION_TOKEN_TTL_MINUTES: OTP.OTP_TTL_MINUTES,
} as const;

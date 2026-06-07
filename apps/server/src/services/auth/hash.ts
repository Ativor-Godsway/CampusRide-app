import { createHash, randomBytes, randomInt } from "node:crypto";
import { OTP } from "./constants";

/**
 * SHA-256 hex digest, used for both OTP codes and refresh tokens.
 *
 * Refresh tokens are high-entropy (256-bit) random values, for which a fast
 * cryptographic hash is standard practice (the search space makes brute
 * force infeasible). OTP codes are short-lived (5 min), single-use, and
 * rate-limited (max 5 verify attempts), so sha256 is adequate there too
 * without pulling in a native bcrypt dependency.
 */
export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Generates a random OTP_LENGTH-digit numeric code, zero-padded. */
export function generateOtpCode(): string {
  const max = 10 ** OTP.OTP_LENGTH;
  return randomInt(0, max).toString().padStart(OTP.OTP_LENGTH, "0");
}

/** Generates a high-entropy refresh token value (256 bits, hex-encoded). */
export function generateRefreshTokenValue(): string {
  return randomBytes(32).toString("hex");
}

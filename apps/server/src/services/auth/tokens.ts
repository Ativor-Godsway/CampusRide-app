import jwt from "jsonwebtoken";
import type { OtpPurpose, UserRole } from "@prisma/client";
import { config } from "../../config";
import { TOKEN } from "./constants";
import { InvalidVerificationTokenError } from "./errors";

export interface AccessTokenPayload {
  userId: string;
  role: UserRole;
}

export interface VerificationTokenPayload {
  phone: string;
  purpose: OtpPurpose;
}

/** Signs a short-lived access token carrying userId + role. */
export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, config.jwtSecret, {
    expiresIn: `${TOKEN.ACCESS_TOKEN_TTL_MINUTES}m`,
  });
}

/** Verifies an access token, throwing the underlying jsonwebtoken error if invalid/expired. */
export function verifyAccessToken(token: string): AccessTokenPayload {
  const decoded = jwt.verify(token, config.jwtSecret);
  return decoded as AccessTokenPayload & jwt.JwtPayload;
}

/**
 * Signs the short-lived "verification token" returned by /auth/verify-otp.
 * Carries the phone + purpose so /auth/signup and /auth/login can confirm
 * OTP ownership without re-presenting the raw OTP code.
 */
export function signVerificationToken(payload: VerificationTokenPayload): string {
  return jwt.sign(payload, config.jwtSecret, {
    expiresIn: `${TOKEN.VERIFICATION_TOKEN_TTL_MINUTES}m`,
  });
}

/**
 * Verifies a verification token and checks it matches the expected phone +
 * purpose. Throws InvalidVerificationTokenError on any failure (expired,
 * malformed, wrong phone, wrong purpose) — callers don't need to
 * distinguish the cause.
 */
export function verifyVerificationToken(
  token: string,
  expectedPhone: string,
  expectedPurpose: OtpPurpose,
): VerificationTokenPayload {
  let decoded: VerificationTokenPayload & jwt.JwtPayload;
  try {
    decoded = jwt.verify(token, config.jwtSecret) as VerificationTokenPayload & jwt.JwtPayload;
  } catch {
    throw new InvalidVerificationTokenError();
  }

  if (decoded.phone !== expectedPhone || decoded.purpose !== expectedPurpose) {
    throw new InvalidVerificationTokenError();
  }

  return { phone: decoded.phone, purpose: decoded.purpose };
}

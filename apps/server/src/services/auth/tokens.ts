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

/**
 * Both kinds of token are signed with the same JWT_SECRET, so each carries a
 * `typ` and each verifier insists on its own kind. Without that, the
 * verification token any phone owner gets from /auth/verify-otp passed as an
 * access token: its payload has no userId, and Prisma treats
 * `where: { riderId: undefined }` as "no filter" — the socket room check let
 * it watch any shared ride, and DELETE /me/push-token removed other users'
 * tokens. The shape checks below are what close that; `typ` is the belt to
 * their braces.
 */
const ACCESS_TYP = "access";
const VERIFICATION_TYP = "otp-verified";

/** The only algorithm we sign with; never let a token pick its own. */
const JWT_ALGORITHMS: jwt.Algorithm[] = ["HS256"];

const USER_ROLES: readonly UserRole[] = ["RIDER", "DRIVER", "ADMIN"];

/**
 * Signs a short-lived access token carrying userId + role. `expiresInSeconds`
 * overrides the usual lifetime (admin sessions are shorter, and never outlive
 * their hard maximum).
 */
export function signAccessToken(payload: AccessTokenPayload, expiresInSeconds?: number): string {
  return jwt.sign({ userId: payload.userId, role: payload.role, typ: ACCESS_TYP }, config.jwtSecret, {
    algorithm: "HS256",
    expiresIn: expiresInSeconds ?? `${TOKEN.ACCESS_TOKEN_TTL_MINUTES}m`,
  });
}

/**
 * Verifies an access token: signature, expiry, and that it IS an access
 * token (a string userId and a known role). Throws on anything else.
 *
 * Tokens issued before `typ` existed have none; they are accepted on shape
 * alone and are all expired within ACCESS_TOKEN_TTL_MINUTES of deploying.
 *
 * Throws ExpiredAccessTokenError only for a real access token of ours whose
 * time is up (signature good, shape good); anything else throws a plain error.
 */
export function verifyAccessToken(token: string): AccessTokenPayload {
  let decoded: string | jwt.JwtPayload;
  try {
    decoded = jwt.verify(token, config.jwtSecret, { algorithms: JWT_ALGORITHMS });
  } catch (err) {
    // jsonwebtoken checks the signature before the expiry, so this is our token.
    if (!(err instanceof jwt.TokenExpiredError)) throw err;
    accessPayload(
      jwt.verify(token, config.jwtSecret, { algorithms: JWT_ALGORITHMS, ignoreExpiration: true }),
    );
    throw new ExpiredAccessTokenError();
  }
  return accessPayload(decoded);
}

/**
 * An access token we signed, for a real account shape, past its expiry: the
 * routine end of every 30-minute token, which the apps answer by refreshing.
 */
export class ExpiredAccessTokenError extends Error {
  constructor() {
    super("access token expired");
    this.name = "ExpiredAccessTokenError";
  }
}

function accessPayload(decoded: string | jwt.JwtPayload): AccessTokenPayload {
  if (typeof decoded !== "object" || decoded === null) throw new Error("malformed access token");
  const { userId, role, typ } = decoded as Record<string, unknown>;
  if (typ !== undefined && typ !== ACCESS_TYP) throw new Error("not an access token");
  if (typeof userId !== "string" || userId.length === 0) throw new Error("access token has no userId");
  if (!USER_ROLES.includes(role as UserRole)) throw new Error("access token has no valid role");
  return { userId, role: role as UserRole };
}

/**
 * Signs the short-lived "verification token" returned by /auth/verify-otp.
 * Carries the phone + purpose so /auth/signup and /auth/login can confirm
 * OTP ownership without re-presenting the raw OTP code.
 */
export function signVerificationToken(payload: VerificationTokenPayload): string {
  return jwt.sign({ phone: payload.phone, purpose: payload.purpose, typ: VERIFICATION_TYP }, config.jwtSecret, {
    algorithm: "HS256",
    expiresIn: `${TOKEN.VERIFICATION_TOKEN_TTL_MINUTES}m`,
  });
}

/**
 * Verifies a verification token and checks it matches the expected phone +
 * purpose. Throws InvalidVerificationTokenError on any failure (expired,
 * malformed, wrong kind, wrong phone, wrong purpose) — callers don't need to
 * distinguish the cause.
 */
export function verifyVerificationToken(
  token: string,
  expectedPhone: string,
  expectedPurpose: OtpPurpose,
): VerificationTokenPayload {
  let decoded: Record<string, unknown>;
  try {
    decoded = jwt.verify(token, config.jwtSecret, { algorithms: JWT_ALGORITHMS }) as Record<string, unknown>;
  } catch {
    throw new InvalidVerificationTokenError();
  }

  if (decoded.typ !== undefined && decoded.typ !== VERIFICATION_TYP) {
    throw new InvalidVerificationTokenError();
  }
  if (decoded.phone !== expectedPhone || decoded.purpose !== expectedPurpose) {
    throw new InvalidVerificationTokenError();
  }

  return { phone: expectedPhone, purpose: expectedPurpose };
}

const DELETION_CONFIRMED_TYP = "admin-deletion-confirmed";

/** What an admin's "the emailed code was right" token is good for: one account, one admin. */
export interface DeletionConfirmPayload {
  /** The account whose phone the code was texted to. */
  userId: string;
  phone: string;
  /** User.id of the admin who checked the code. */
  actor: string;
}

/**
 * Signs the token the admin site gets back once an emailed deletion code
 * checks out (routes/adminAccountDeletion.ts). It unlocks "Delete account"
 * for that account, by that admin, for VERIFICATION_TOKEN_TTL_MINUTES — and
 * nothing else: its `typ` is neither an access token's nor an OTP
 * verification token's, so neither verifier accepts it.
 */
export function signDeletionConfirmToken(payload: DeletionConfirmPayload): string {
  return jwt.sign(
    { userId: payload.userId, phone: payload.phone, actor: payload.actor, typ: DELETION_CONFIRMED_TYP },
    config.jwtSecret,
    { algorithm: "HS256", expiresIn: `${TOKEN.VERIFICATION_TOKEN_TTL_MINUTES}m` },
  );
}

/**
 * Checks a deletion confirm token was issued for this phone to this admin,
 * and returns the account it confirms. Throws InvalidVerificationTokenError
 * on anything else (expired, malformed, another kind, another phone or admin).
 */
export function verifyDeletionConfirmToken(
  token: string,
  expected: { phone: string; actor: string },
): DeletionConfirmPayload {
  let decoded: Record<string, unknown>;
  try {
    decoded = jwt.verify(token, config.jwtSecret, { algorithms: JWT_ALGORITHMS }) as Record<string, unknown>;
  } catch {
    throw new InvalidVerificationTokenError();
  }
  const { userId, phone, actor, typ } = decoded;
  if (typ !== DELETION_CONFIRMED_TYP || typeof userId !== "string" || userId.length === 0) {
    throw new InvalidVerificationTokenError();
  }
  if (phone !== expected.phone || actor !== expected.actor) throw new InvalidVerificationTokenError();
  return { userId, phone, actor };
}

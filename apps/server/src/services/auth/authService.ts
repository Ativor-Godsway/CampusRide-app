import type { PrismaClient, User } from "@prisma/client";
import { TOKEN } from "./constants";
import { generateRefreshTokenValue, sha256 } from "./hash";
import {
  InvalidRefreshTokenError,
  PhoneAlreadyRegisteredError,
  UserNotFoundError,
} from "./errors";
import { signAccessToken, verifyVerificationToken } from "./tokens";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

/** Signs a fresh access token and creates+stores a new refresh token row for `user`. */
async function issueTokens(
  prisma: PrismaClient,
  user: Pick<User, "id" | "role">,
  now: Date = new Date(),
): Promise<AuthTokens> {
  const accessToken = signAccessToken({ userId: user.id, role: user.role });

  const refreshToken = generateRefreshTokenValue();
  const expiresAt = new Date(now.getTime() + TOKEN.REFRESH_TOKEN_TTL_DAYS * DAY_MS);

  await prisma.refreshToken.create({
    data: { userId: user.id, tokenHash: sha256(refreshToken), expiresAt },
  });

  return { accessToken, refreshToken };
}

export type SignupRole = "RIDER" | "DRIVER";

export interface SignupInput {
  phone: string;
  name: string;
  role: SignupRole;
  /** Verification token returned by /auth/verify-otp for purpose=SIGNUP. */
  verifiedToken: string;
}

export interface SignupResult extends AuthTokens {
  user: User;
}

/**
 * Creates a new User (and, for DRIVER, a pending Driver row with
 * isApproved=false and an empty profile awaiting completeDriverProfile).
 * Throws PhoneAlreadyRegisteredError if the phone is already registered.
 */
export async function signup(prisma: PrismaClient, input: SignupInput): Promise<SignupResult> {
  verifyVerificationToken(input.verifiedToken, input.phone, "SIGNUP");

  const existing = await prisma.user.findUnique({ where: { phone: input.phone } });
  if (existing) {
    throw new PhoneAlreadyRegisteredError(input.phone);
  }

  const user = await prisma.user.create({
    data: { phone: input.phone, name: input.name, role: input.role },
  });

  if (input.role === "DRIVER") {
    await prisma.driver.create({ data: { userId: user.id, isApproved: false } });
  }

  const tokens = await issueTokens(prisma, user);
  return { user, ...tokens };
}

export interface LoginInput {
  phone: string;
  /** Verification token returned by /auth/verify-otp for purpose=LOGIN. */
  verifiedToken: string;
}

export interface LoginResult extends AuthTokens {
  user: User;
}

/** Logs in an existing user. Throws UserNotFoundError if no account exists for the phone. */
export async function login(prisma: PrismaClient, input: LoginInput): Promise<LoginResult> {
  verifyVerificationToken(input.verifiedToken, input.phone, "LOGIN");

  const user = await prisma.user.findUnique({ where: { phone: input.phone } });
  if (!user) {
    throw new UserNotFoundError(input.phone);
  }

  const tokens = await issueTokens(prisma, user);
  return { user, ...tokens };
}

/**
 * Validates a refresh token and rotates it: the old token is revoked and a
 * new access + refresh token pair is issued. Reusing a revoked/expired/
 * unknown token throws InvalidRefreshTokenError.
 */
export async function refresh(
  prisma: PrismaClient,
  refreshToken: string,
  now: Date = new Date(),
): Promise<AuthTokens> {
  const tokenHash = sha256(refreshToken);

  const stored = await prisma.refreshToken.findFirst({
    where: { tokenHash },
    include: { user: true },
  });

  if (!stored || stored.revokedAt || stored.expiresAt < now) {
    throw new InvalidRefreshTokenError();
  }

  await prisma.refreshToken.update({
    where: { id: stored.id },
    data: { revokedAt: now },
  });

  return issueTokens(prisma, stored.user, now);
}

/** Revokes a single refresh token (e.g. on logout). Throws InvalidRefreshTokenError if unknown/already revoked. */
export async function logout(
  prisma: PrismaClient,
  refreshToken: string,
  now: Date = new Date(),
): Promise<void> {
  const tokenHash = sha256(refreshToken);

  const stored = await prisma.refreshToken.findFirst({ where: { tokenHash } });
  if (!stored || stored.revokedAt) {
    throw new InvalidRefreshTokenError();
  }

  await prisma.refreshToken.update({
    where: { id: stored.id },
    data: { revokedAt: now },
  });
}

/** Revokes all of a user's active refresh tokens (e.g. on suspected compromise). */
export async function revokeAllForUser(
  prisma: PrismaClient,
  userId: string,
  now: Date = new Date(),
): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: now },
  });
}

export interface CompleteDriverProfileInput {
  carMake: string;
  carModel: string;
  carColor: string;
  plate: string;
  /**
   * Phase 3: a placeholder/stubbed URL is acceptable here. Real Cloudinary
   * upload wiring is deferred to a later phase.
   */
  photoUrl: string;
}

/** Fills in the driver profile fields created (empty) at DRIVER signup. */
export async function completeDriverProfile(
  prisma: PrismaClient,
  userId: string,
  input: CompleteDriverProfileInput,
) {
  return prisma.driver.update({
    where: { userId },
    data: {
      carMake: input.carMake,
      carModel: input.carModel,
      carColor: input.carColor,
      plate: input.plate,
      photoUrl: input.photoUrl,
    },
  });
}

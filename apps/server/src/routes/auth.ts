import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { OtpService } from "../services/otp/OtpService";
import { requestOtp, verifyOtp } from "../services/auth/otp";
import {
  completeDriverProfile,
  login,
  logout,
  refresh,
  signup,
  type SignupRole,
} from "../services/auth/authService";
import {
  InvalidOtpError,
  InvalidRefreshTokenError,
  InvalidVerificationTokenError,
  RefreshTokenReuseError,
  OtpAttemptsExceededError,
  OtpExpiredError,
  OtpRateLimitExceededError,
  PhoneAlreadyRegisteredError,
  UserNotFoundError,
} from "../services/auth/errors";
import { requireAuth } from "../middleware/auth";
import { meSelect } from "./selects";
import { InvalidEmergencyContactError, updateRiderProfile } from "../services/auth/profile";
import {
  AccountAlreadyDeletedError,
  ActiveRideBlocksDeletionError,
  deleteAccount,
} from "../services/auth/deleteAccount";
import { config } from "../config";
import { normalizePhone } from "../lib/phone";

/** Shared window for the per-IP auth rate limits (max counts come from config). */
const AUTH_RATE_WINDOW = "15 minutes";

const OTP_PURPOSES = ["SIGNUP", "LOGIN"] as const;
const SIGNUP_ROLES = ["RIDER", "DRIVER"] as const;

function isOtpPurpose(value: unknown): value is (typeof OTP_PURPOSES)[number] {
  return typeof value === "string" && (OTP_PURPOSES as readonly string[]).includes(value);
}

function isSignupRole(value: unknown): value is SignupRole {
  return typeof value === "string" && (SIGNUP_ROLES as readonly string[]).includes(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * PHONE CANONICALIZATION. Every route below keys on the phone string:
 * OtpCode.phone, User.phone, and the signed verification token whose payload
 * verifyVerificationToken compares byte-for-byte. They must all agree on ONE
 * spelling, or a code requested as "0548608146" cannot be verified as
 * "+233548608146", and a token minted by one endpoint is rejected by the next.
 *
 * So each handler runs `normalizePhone` on the way in and passes only the
 * canonical "+233XXXXXXXXX" downstream — nothing below this layer, including
 * the database, ever sees a local or bare-msisdn form. A number that does not
 * normalize is a 400 here rather than a row nobody can log into later.
 */
const PHONE_NOT_GHANAIAN = "phone is not a valid Ghanaian number";

export function registerAuthRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  otpService: OtpService,
): void {
  app.post(
    "/auth/request-otp",
    { config: { rateLimit: { max: config.rateLimit.otpRequestMax, timeWindow: AUTH_RATE_WINDOW } } },
    async (request, reply) => {
    const body = request.body as { phone?: unknown; purpose?: unknown };

    if (!isNonEmptyString(body.phone) || !isOtpPurpose(body.purpose)) {
      return reply.code(400).send({ error: "phone and purpose (SIGNUP|LOGIN) are required" });
    }

    const phone = normalizePhone(body.phone);
    if (!phone) {
      return reply.code(400).send({ error: PHONE_NOT_GHANAIAN });
    }

    try {
      await requestOtp(prisma, otpService, phone, body.purpose);
      return reply.code(200).send({ ok: true });
    } catch (err) {
      if (err instanceof OtpRateLimitExceededError) {
        return reply.code(429).send({ error: err.message });
      }
      throw err;
    }
  });

  app.post(
    "/auth/verify-otp",
    { config: { rateLimit: { max: config.rateLimit.otpVerifyMax, timeWindow: AUTH_RATE_WINDOW } } },
    async (request, reply) => {
    const body = request.body as { phone?: unknown; code?: unknown; purpose?: unknown };

    if (
      !isNonEmptyString(body.phone) ||
      !isNonEmptyString(body.code) ||
      !isOtpPurpose(body.purpose)
    ) {
      return reply.code(400).send({ error: "phone, code, and purpose (SIGNUP|LOGIN) are required" });
    }

    try {
      const phone = normalizePhone(body.phone);
      if (!phone) {
        return reply.code(400).send({ error: PHONE_NOT_GHANAIAN });
      }

      const result = await verifyOtp(prisma, phone, body.code, body.purpose);
      return reply.code(200).send(result);
    } catch (err) {
      if (
        err instanceof InvalidOtpError ||
        err instanceof OtpExpiredError ||
        err instanceof OtpAttemptsExceededError
      ) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  app.post(
    "/auth/signup",
    { config: { rateLimit: { max: config.rateLimit.signupMax, timeWindow: AUTH_RATE_WINDOW } } },
    async (request, reply) => {
    const body = request.body as {
      phone?: unknown;
      name?: unknown;
      role?: unknown;
      verifiedToken?: unknown;
    };

    if (
      !isNonEmptyString(body.phone) ||
      !isNonEmptyString(body.name) ||
      !isSignupRole(body.role) ||
      !isNonEmptyString(body.verifiedToken)
    ) {
      return reply
        .code(400)
        .send({ error: "phone, name, role (RIDER|DRIVER), and verifiedToken are required" });
    }

    const phone = normalizePhone(body.phone);
    if (!phone) {
      return reply.code(400).send({ error: PHONE_NOT_GHANAIAN });
    }

    try {
      const result = await signup(prisma, {
        phone,
        name: body.name,
        role: body.role,
        verifiedToken: body.verifiedToken,
      });
      return reply.code(201).send(result);
    } catch (err) {
      if (err instanceof InvalidVerificationTokenError) {
        return reply.code(401).send({ error: err.message });
      }
      if (err instanceof PhoneAlreadyRegisteredError) {
        return reply.code(409).send({ error: err.message });
      }
      throw err;
    }
  });

  app.post(
    "/auth/login",
    { config: { rateLimit: { max: config.rateLimit.loginMax, timeWindow: AUTH_RATE_WINDOW } } },
    async (request, reply) => {
    const body = request.body as { phone?: unknown; verifiedToken?: unknown };

    if (!isNonEmptyString(body.phone) || !isNonEmptyString(body.verifiedToken)) {
      return reply.code(400).send({ error: "phone and verifiedToken are required" });
    }

    const phone = normalizePhone(body.phone);
    if (!phone) {
      return reply.code(400).send({ error: PHONE_NOT_GHANAIAN });
    }

    try {
      const result = await login(prisma, {
        phone,
        verifiedToken: body.verifiedToken,
      });
      return reply.code(200).send(result);
    } catch (err) {
      if (err instanceof InvalidVerificationTokenError) {
        return reply.code(401).send({ error: err.message });
      }
      if (err instanceof UserNotFoundError) {
        return reply.code(404).send({ error: err.message });
      }
      throw err;
    }
  });

  app.post(
    "/auth/refresh",
    { config: { rateLimit: { max: config.rateLimit.refreshMax, timeWindow: AUTH_RATE_WINDOW } } },
    async (request, reply) => {
    const body = request.body as { refreshToken?: unknown };

    if (!isNonEmptyString(body.refreshToken)) {
      return reply.code(400).send({ error: "refreshToken is required" });
    }

    try {
      const result = await refresh(prisma, body.refreshToken);
      return reply.code(200).send(result);
    } catch (err) {
      if (err instanceof RefreshTokenReuseError) {
        // Every token in this login's rotation chain has just been revoked.
        // Log it as the security event it is — but answer EXACTLY as for any
        // other invalid token (same status, same message), so an attacker
        // learns nothing about whether they tripped the detector.
        request.log.warn(
          { userId: err.userId, event: "refresh_token_reuse" },
          "Refresh token reuse detected — revoked the entire token family",
        );
        return reply.code(401).send({ error: err.message });
      }
      if (err instanceof InvalidRefreshTokenError) {
        return reply.code(401).send({ error: err.message });
      }
      throw err;
    }
  });

  app.post("/auth/logout", async (request, reply) => {
    const body = request.body as { refreshToken?: unknown };

    if (!isNonEmptyString(body.refreshToken)) {
      return reply.code(400).send({ error: "refreshToken is required" });
    }

    try {
      await logout(prisma, body.refreshToken);
      return reply.code(200).send({ ok: true });
    } catch (err) {
      if (err instanceof InvalidRefreshTokenError) {
        return reply.code(401).send({ error: err.message });
      }
      throw err;
    }
  });

  app.get("/me", { preHandler: requireAuth }, async (request, reply) => {
    // Explicit select (routes/selects.ts) so a future User column is not
    // published to clients just by existing.
    const user = await prisma.user.findUnique({
      where: { id: request.user!.userId },
      select: meSelect,
    });

    if (!user) {
      return reply.code(404).send({ error: "User not found" });
    }

    return reply.code(200).send({ user });
  });

  /**
   * Partial profile update for the signed-in user — the rider-side mirror of
   * PATCH /driver/profile. Handles the display name and the single emergency
   * contact used by POST /rides/:id/sos.
   *
   * `phone` is not updatable here: it is the login identity, so changing it
   * needs a fresh OTP verification of the new number (its own flow, not this
   * one).
   */
  app.patch("/me", { preHandler: requireAuth }, async (request, reply) => {
    const body = (request.body ?? {}) as {
      name?: unknown;
      emergencyContactName?: unknown;
      emergencyContactPhone?: unknown;
    };

    // `null` is meaningful for the contact fields — it CLEARS them — so it is
    // accepted, while any other non-string is a client bug.
    const input: {
      name?: string;
      emergencyContactName?: string | null;
      emergencyContactPhone?: string | null;
    } = {};

    if (body.name !== undefined) {
      if (typeof body.name !== "string") {
        return reply.code(400).send({ error: "name must be a string" });
      }
      input.name = body.name;
    }
    for (const field of ["emergencyContactName", "emergencyContactPhone"] as const) {
      const value = body[field];
      if (value === undefined) continue;
      if (value !== null && typeof value !== "string") {
        return reply.code(400).send({ error: `${field} must be a string or null` });
      }
      input[field] = value;
    }

    try {
      await updateRiderProfile(prisma, request.user!.userId, input);
    } catch (err) {
      if (err instanceof InvalidEmergencyContactError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }

    // Return the same shape as GET /me so the client can swap it straight in.
    const user = await prisma.user.findUnique({
      where: { id: request.user!.userId },
      select: meSelect,
    });
    return reply.code(200).send({ user });
  });

  /**
   * In-app account deletion (app-store requirement, and the only way a user
   * could previously leave was to ask a human).
   *
   * Anonymizes rather than row-deletes — see services/auth/deleteAccount.ts
   * for why the row has to survive. Idempotent from the client's point of
   * view: a second call with a still-valid access token gets 404, not a 500.
   */
  app.delete("/me", { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.user!.userId;

    try {
      await deleteAccount(prisma, userId);
    } catch (err) {
      if (err instanceof ActiveRideBlocksDeletionError) {
        return reply.code(409).send({ error: err.message, rideId: err.rideId });
      }
      if (err instanceof AccountAlreadyDeletedError) {
        return reply.code(404).send({ error: err.message });
      }
      throw err;
    }

    request.log.info({ userId, event: "account_deleted" }, "Account anonymized on user request");
    return reply.code(200).send({ deleted: true });
  });

  app.post("/driver/profile", { preHandler: requireAuth }, async (request, reply) => {
    const body = request.body as {
      carMake?: unknown;
      carModel?: unknown;
      carColor?: unknown;
      plate?: unknown;
      photoUrl?: unknown;
    };

    if (
      !isNonEmptyString(body.carMake) ||
      !isNonEmptyString(body.carModel) ||
      !isNonEmptyString(body.carColor) ||
      !isNonEmptyString(body.plate)
    ) {
      return reply
        .code(400)
        .send({ error: "carMake, carModel, carColor, and plate are required" });
    }

    if (request.user!.role !== "DRIVER") {
      return reply.code(403).send({ error: "Only DRIVER accounts have a driver profile" });
    }

    const driver = await completeDriverProfile(prisma, request.user!.userId, {
      carMake: body.carMake,
      carModel: body.carModel,
      carColor: body.carColor,
      plate: body.plate,
      ...(isNonEmptyString(body.photoUrl) ? { photoUrl: body.photoUrl } : {}),
    });

    return reply.code(200).send({ driver });
  });
}

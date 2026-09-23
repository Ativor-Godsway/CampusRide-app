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
import {
  AccountAlreadyDeletedError,
  ActiveRideBlocksDeletionError,
  deleteAccount,
} from "../services/auth/deleteAccount";
import { config } from "../config";

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

    try {
      await requestOtp(prisma, otpService, body.phone, body.purpose);
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
      const result = await verifyOtp(prisma, body.phone, body.code, body.purpose);
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

    try {
      const result = await signup(prisma, {
        phone: body.phone,
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

    try {
      const result = await login(prisma, {
        phone: body.phone,
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

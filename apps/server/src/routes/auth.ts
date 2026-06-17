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
  OtpAttemptsExceededError,
  OtpExpiredError,
  OtpRateLimitExceededError,
  PhoneAlreadyRegisteredError,
  UserNotFoundError,
} from "../services/auth/errors";
import { requireAuth } from "../middleware/auth";

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
  app.post("/auth/request-otp", async (request, reply) => {
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

  app.post("/auth/verify-otp", async (request, reply) => {
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

  app.post("/auth/signup", async (request, reply) => {
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

  app.post("/auth/login", async (request, reply) => {
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

  app.post("/auth/refresh", async (request, reply) => {
    const body = request.body as { refreshToken?: unknown };

    if (!isNonEmptyString(body.refreshToken)) {
      return reply.code(400).send({ error: "refreshToken is required" });
    }

    try {
      const result = await refresh(prisma, body.refreshToken);
      return reply.code(200).send(result);
    } catch (err) {
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
    const user = await prisma.user.findUnique({
      where: { id: request.user!.userId },
      include: { driver: true },
    });

    if (!user) {
      return reply.code(404).send({ error: "User not found" });
    }

    return reply.code(200).send({ user });
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

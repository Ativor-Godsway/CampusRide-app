import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { requireAuth } from "../middleware/auth";
import {
  InvalidPushTokenError,
  registerPushToken,
  removePushToken,
} from "../services/push/pushService";

/** Per user, per 15 minutes: an app registers on each launch, rarely more. */
const PUSH_TOKEN_RATE_MAX = 30;

const perUser = {
  rateLimit: {
    max: PUSH_TOKEN_RATE_MAX,
    timeWindow: "15 minutes",
    hook: "preHandler" as const,
    keyGenerator: (request: FastifyRequest) => `user:${request.user?.userId ?? request.ip}`,
  },
};

/**
 * Push notification tokens (services/push).
 *
 * - PUT /me/push-token    { token, app: "rider"|"driver", platform: "android"|"ios" }
 *   Saves this install's Expo push token for the signed-in user (moving it
 *   from whoever had it before). The apps call it after the user allows
 *   notifications and on each launch while signed in.
 * - DELETE /me/push-token { token }
 *   Stops this install getting the user's notifications. Log out does the
 *   same through POST /auth/logout's optional pushToken.
 */
export function registerPushRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  app.put(
    "/me/push-token",
    { preHandler: requireAuth, config: perUser },
    async (request, reply) => {
      const body = (request.body ?? {}) as { token?: unknown; app?: unknown; platform?: unknown };
      try {
        await registerPushToken(
          prisma,
          { userId: request.user!.userId, role: request.user!.role },
          body,
        );
      } catch (err) {
        if (err instanceof InvalidPushTokenError)
          return reply.code(400).send({ error: err.message });
        throw err;
      }
      return reply.code(200).send({ ok: true });
    },
  );

  app.delete(
    "/me/push-token",
    { preHandler: requireAuth, config: perUser },
    async (request, reply) => {
      const { token } = (request.body ?? {}) as { token?: unknown };
      if (typeof token !== "string" || token.length === 0 || token.length > 255) {
        return reply.code(400).send({ error: "token is required" });
      }
      await removePushToken(prisma, request.user!.userId, token);
      return reply.code(200).send({ ok: true });
    },
  );
}

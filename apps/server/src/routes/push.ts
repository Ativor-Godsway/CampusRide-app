import type { FastifyInstance } from "fastify";
import { useRequestValidation } from "../http/validation";
import type { PrismaClient } from "@prisma/client";
import { requireAuth } from "../middleware/auth";
import {
  InvalidPushTokenError,
  registerPushToken,
  removePushToken,
} from "../services/push/pushService";

import { RULES } from "../rateLimit/rules";
import { MAX, empty, object, oneOf, text } from "../http/schemas";

const pushToken = text(MAX.pushToken, { nonEmpty: true });
/** Request schemas (http/schemas.ts): unknown fields are dropped before the handler. */
const SCHEMAS = {
  register: {
    body: object(
      { token: pushToken, app: oneOf(["rider", "driver"]), platform: oneOf(["android", "ios"]) },
      ["token", "app", "platform"],
    ),
  },
  remove: { body: object({ token: pushToken }, ["token"]), querystring: empty },
};

/** Per account: an app sends its token once, then only when it changes. */
const perUser = { limits: { user: [RULES.pushToken] } };
/**
 * The app calls this by itself, never the person: counted against its own
 * limit only, so a phone stuck re-sending it (the first TestFlight builds did,
 * many times a second) can't use up the account's allowance for everything else.
 */
const ownLimitOnly = { limits: { user: [RULES.pushToken], userDefault: false as const } };

/**
 * Push notification tokens (services/push).
 *
 * - PUT /me/push-token    { token, app: "rider"|"driver", platform: "android"|"ios" }
 *   Saves this install's Expo push token for the signed-in user (moving it
 *   from whoever had it before). The apps call it after the user allows
 *   notifications, and when the token or the person changes. Sending the
 *   same token again writes nothing.
 * - DELETE /me/push-token { token }
 *   Stops this install getting the user's notifications. Log out does the
 *   same through POST /auth/logout's optional pushToken.
 */
export function registerPushRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  useRequestValidation(app);
  app.put(
    "/me/push-token",
    { onRequest: requireAuth, schema: SCHEMAS.register, config: ownLimitOnly },
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
    { onRequest: requireAuth, schema: SCHEMAS.remove, config: perUser },
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

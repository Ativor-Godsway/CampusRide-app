import type { FastifyInstance, FastifyReply } from "fastify";
import type { PrismaClient } from "@prisma/client";
import {
  BROADCAST_AUDIENCES,
  BROADCAST_BODY_MAX,
  BROADCAST_TITLE_MAX,
  rateLimitedBody,
  retryAfterText,
  type BroadcastAudience,
} from "@rida/shared";
import { useRequestValidation } from "../http/validation";
import { adminOnly, requireAdmin, requireAuth } from "../middleware/auth";
import { noInput, object, oneOf, phone as phoneField, text } from "../http/schemas";
import {
  BroadcastError,
  broadcastHistory,
  previewAudience,
  sendTestToSelf,
  startBroadcast,
} from "../services/push/broadcast";

/**
 * The admin site's Notifications page (services/push/broadcast.ts): write a
 * notification and send it to all riders, all drivers, everyone, or one
 * phone number's account — or as a test to the admin's own number.
 *
 * - GET  /admin/notifications: the send history and the caps' use this hour.
 * - GET  /admin/notifications/audience: how many installs a send would reach (the confirm box).
 * - POST /admin/notifications: sends; answers at once, delivery runs in the background.
 * - POST /admin/notifications/test: sends to the admin's own number and waits.
 *
 * Every send is audit-logged (notification.send / notification.test).
 * Texts are length-checked here too, so an oversized body never reaches a handler.
 */

// A little slack over the limits: the service trims, then checks and says what's wrong in words.
const TEXT = {
  title: text(BROADCAST_TITLE_MAX + 20),
  body: text(BROADCAST_BODY_MAX + 40),
};

const SCHEMAS = {
  history: noInput,
  audience: {
    querystring: object({ audience: oneOf(BROADCAST_AUDIENCES), phone: phoneField }, ["audience"]),
  },
  send: {
    body: object(
      { audience: oneOf(BROADCAST_AUDIENCES), phone: phoneField, ...TEXT },
      ["audience", "title", "body"],
    ),
  },
  test: { body: object(TEXT, ["title", "body"]) },
};

function refuse(reply: FastifyReply, err: unknown): FastifyReply {
  if (!(err instanceof BroadcastError)) throw err;
  if (err.status === 429) {
    const body = rateLimitedBody(err.retryAfterSeconds ?? 60);
    return reply
      .code(429)
      .header("retry-after", String(body.retryAfterSeconds))
      .send({ ...body, error: `${err.message} The next can go out in ${retryAfterText(body.retryAfterSeconds)}.` });
  }
  return reply.code(err.status).send({ error: err.message });
}

export function registerNotificationRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  useRequestValidation(app);
  const admin = { onRequest: [requireAuth, adminOnly] };

  app.get("/admin/notifications", { ...admin, schema: SCHEMAS.history }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    return reply.send(await broadcastHistory(prisma));
  });

  /** `?audience=&phone=`: the installs a send would reach now, and for one number, whose account it is. */
  app.get("/admin/notifications/audience", { ...admin, schema: SCHEMAS.audience }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const { audience, phone } = request.query as { audience: BroadcastAudience; phone?: string };
    try {
      return reply.send(await previewAudience(prisma, audience, phone));
    } catch (err) {
      return refuse(reply, err);
    }
  });

  /** Body `{ audience, phone?, title, body }`: 202 with the history row; delivery continues in the background. */
  app.post("/admin/notifications", { ...admin, schema: SCHEMAS.send }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const body = request.body as { audience: BroadcastAudience; phone?: string; title: string; body: string };
    try {
      const broadcast = await startBroadcast(prisma, request.user!.userId, body);
      request.log.info(
        { event: "notification_sent", actor: request.user!.userId, broadcastId: broadcast.id, kind: broadcast.kind, devices: broadcast.devices },
        "Admin notification sent",
      );
      return reply.code(202).send({ broadcast });
    } catch (err) {
      return refuse(reply, err);
    }
  });

  /** Body `{ title, body }`: to the admin's own number only; says why when nothing could arrive. */
  app.post("/admin/notifications/test", { ...admin, schema: SCHEMAS.test }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    try {
      return reply.send(await sendTestToSelf(prisma, request.user!.userId, request.body as { title: string; body: string }));
    } catch (err) {
      return refuse(reply, err);
    }
  });
}

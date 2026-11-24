import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import {
  MY_SERVICE_STATUS_PATH,
  SERVICE_MESSAGE_MAX,
  SERVICE_NOTIFY_PATH,
  SERVICE_OVERRIDE_MODES,
  serviceStateLine,
  serviceStatusFromState,
  type MyServiceStatus,
  type ServiceOverrideMode,
} from "@rida/shared";
import { useRequestValidation } from "../http/validation";
import { adminOnly, requireAdmin, requireAuth } from "../middleware/auth";
import { boolean, bodyOptional, empty, noInput, object, oneOf, text } from "../http/schemas";
import {
  ServiceHoursError,
  addOpeningWaiter,
  countOnlineDrivers,
  countOpeningWaiters,
  isServiceHoursExempt,
  isServiceOpen,
  isWaitingForOpening,
  readServiceHours,
  removeOpeningWaiter,
  saveServiceHours,
  serviceStatus,
  setServiceOverride,
} from "../services/service/serviceHours";
import { announceServiceSoon } from "../services/service/serviceAnnouncer";

/**
 * Service hours (services/service/serviceHours.ts): when riders can book.
 *
 * - The public state is in GET /app/config (`service`, routes/appVersion.ts).
 * - GET /me/service-status: the same, plus whether this account books
 *   whatever the hours say (review demo, admin) and whether it asked to be
 *   told at the next opening. The rider and driver apps ask this one.
 * - POST / DELETE /me/service-notify: "Notify me when you open" on and off.
 * - Admin Settings: read; save the schedule, closed message and no-drivers
 *   switch; Open now / Close now / back to the schedule. Each change is
 *   audit-logged, and announced to the apps over the socket at once.
 */

const HHMM = { type: "string", maxLength: 5, pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$|^24:00$" } as const;
const DAY = {
  type: ["object", "null"],
  additionalProperties: false,
  properties: { open: HHMM, close: HHMM },
  required: ["open", "close"],
} as const;

const SCHEMAS = {
  mine: noInput,
  notify: { body: empty },
  stopNotify: { querystring: empty, body: empty },
  admin: noInput,
  save: {
    body: object(
      {
        weekly: { type: "array", minItems: 7, maxItems: 7, items: DAY },
        closedMessage: text(SERVICE_MESSAGE_MAX, { nullable: true }),
        blockWhenNoDrivers: boolean,
      },
      ["weekly", "blockWhenNoDrivers"],
    ),
  },
  override: { body: object({ mode: oneOf(SERVICE_OVERRIDE_MODES, { nullable: true }) }, ["mode"]) },
};

export function registerServiceHoursRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  useRequestValidation(app);

  app.get(MY_SERVICE_STATUS_PATH, { onRequest: requireAuth, schema: SCHEMAS.mine }, async (request, reply) => {
    const userId = request.user!.userId;
    const [status, user, notifyMe] = await Promise.all([
      serviceStatus(prisma),
      prisma.user.findUnique({ where: { id: userId }, select: { role: true, isReviewDemo: true } }),
      isWaitingForOpening(prisma, userId),
    ]);
    const body: MyServiceStatus = { ...status, exempt: user ? isServiceHoursExempt(user) : false, notifyMe };
    return reply.header("cache-control", "no-store").send(body);
  });

  /** "Notify me when you open": refused (409) while riders can book — there is nothing to wait for. */
  app.post(
    SERVICE_NOTIFY_PATH,
    { onRequest: requireAuth, preValidation: bodyOptional, schema: SCHEMAS.notify },
    async (request, reply) => {
      if (request.user!.role !== "RIDER") return reply.code(403).send({ error: "Only riders can ask to be notified" });
      const state = await isServiceOpen(prisma);
      if (state.open) return reply.code(409).send({ error: "CampusRide is open now. You can book a ride." });
      await addOpeningWaiter(prisma, request.user!.userId);
      return reply.send({ notifyMe: true });
    },
  );

  app.delete(
    SERVICE_NOTIFY_PATH,
    { onRequest: requireAuth, preValidation: bodyOptional, schema: SCHEMAS.stopNotify },
    async (request, reply) => {
      await removeOpeningWaiter(prisma, request.user!.userId);
      return reply.send({ notifyMe: false });
    },
  );

  // ─── Admin Settings ─────────────────────────────────────────────────────

  app.get("/admin/service-hours", { onRequest: [requireAuth, adminOnly], schema: SCHEMAS.admin }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const now = new Date();
    const [stored, state, driversOnline, waiting] = await Promise.all([
      readServiceHours(prisma),
      isServiceOpen(prisma, now),
      countOnlineDrivers(prisma),
      countOpeningWaiters(prisma),
    ]);
    const updatedBy = stored.updatedBy
      ? await prisma.user.findUnique({ where: { id: stored.updatedBy }, select: { id: true, name: true } })
      : null;
    const { settings } = stored;
    return reply.header("cache-control", "no-store").send({
      setting: {
        weekly: settings.weekly,
        override: settings.override
          ? { mode: settings.override.mode, until: settings.override.until?.toISOString() ?? null }
          : null,
        closedMessage: settings.closedMessage,
        blockWhenNoDrivers: settings.blockWhenNoDrivers,
        updatedAt: stored.updatedAt?.toISOString() ?? null,
        updatedBy,
      },
      status: serviceStatusFromState(state, now),
      stateLine: serviceStateLine(state, now),
      driversOnline,
      waiting,
    });
  });

  /** Body `{ weekly, closedMessage, blockWhenNoDrivers }`: weekly has 7 days, index 0 = Sunday. */
  app.put("/admin/service-hours", { onRequest: [requireAuth, adminOnly], schema: SCHEMAS.save }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const body = request.body as { weekly: unknown; closedMessage?: string | null; blockWhenNoDrivers: boolean };
    try {
      await saveServiceHours(prisma, request.user!.userId, {
        weekly: body.weekly,
        closedMessage: body.closedMessage ?? null,
        blockWhenNoDrivers: body.blockWhenNoDrivers,
      });
    } catch (err) {
      if (err instanceof ServiceHoursError) return reply.code(400).send({ error: err.message });
      throw err;
    }
    request.log.info({ event: "service_hours_saved", actor: request.user!.userId }, "Service hours saved");
    announceServiceSoon(prisma);
    return reply.send({ status: await serviceStatus(prisma) });
  });

  /** Body `{ mode }`: "OPEN" (Open now), "CLOSED" (Close now) or null (back to the schedule). */
  app.put(
    "/admin/service-hours/override",
    { onRequest: [requireAuth, adminOnly], schema: SCHEMAS.override },
    async (request, reply) => {
      if (!(await requireAdmin(request, reply))) return;
      const { mode } = request.body as { mode: ServiceOverrideMode | null };
      await setServiceOverride(prisma, request.user!.userId, mode);
      request.log.info({ event: "service_hours_override", actor: request.user!.userId, mode }, "Service hours override");
      announceServiceSoon(prisma);
      return reply.send({ status: await serviceStatus(prisma) });
    },
  );
}

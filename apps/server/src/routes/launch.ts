import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { LAUNCH_MODES, LAUNCH_STATUS_PATH, MY_LAUNCH_STATUS_PATH, type LaunchMode } from "@rida/shared";
import { useRequestValidation } from "../http/validation";
import { adminOnly, requireAdmin, requireAuth } from "../middleware/auth";
import { normalizePhone } from "../lib/phone";
import { boolean, bodyOptional, empty, noInput, object, oneOf, phone as phoneField, text } from "../http/schemas";
import {
  LaunchSettingError,
  canRideNow,
  countEarlyAccess,
  grantEarlyAccessToAllRiders,
  launchStatus,
  readLaunchSetting,
  setEarlyAccess,
  setLaunchMode,
} from "../services/launch/launchSettings";

/**
 * Launch mode (services/launch/launchSettings.ts): the countdown before the
 * public launch.
 *
 * - GET /launch-status: public, the same for everyone — the mode in force,
 *   the launch time and the server's clock (so a wrong phone clock can't
 *   move the countdown).
 * - GET /me/launch-status: the same, plus whether the caller can book now.
 *   The rider app asks this one: early-access riders see no countdown.
 * - Admin Settings: read and set the mode; give or take one rider's early
 *   access; give it to every current rider. Each change is audit-logged.
 */

const SCHEMAS = {
  status: noInput,
  admin: noInput,
  setLaunch: {
    body: object({ mode: oneOf(LAUNCH_MODES), launchAt: text(40, { nullable: true }) }, ["mode"]),
  },
  lookUp: { querystring: object({ phone: phoneField }, ["phone"]) },
  setAccess: { body: object({ phone: phoneField, enabled: boolean }, ["phone", "enabled"]) },
  grantAll: { body: empty },
};

const ACCOUNT_SELECT = { id: true, name: true, role: true, earlyAccessAt: true } as const;

export function registerLaunchRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  useRequestValidation(app);

  app.get(LAUNCH_STATUS_PATH, { schema: SCHEMAS.status }, async (_request, reply) => {
    // Always the current answer: a change in Settings reaches every phone at its next check.
    return reply.header("cache-control", "no-store").send(await launchStatus(prisma));
  });

  app.get(MY_LAUNCH_STATUS_PATH, { onRequest: requireAuth, schema: SCHEMAS.status }, async (request, reply) => {
    const now = new Date();
    const [status, canRide] = await Promise.all([
      launchStatus(prisma, now),
      canRideNow(prisma, request.user!.userId, now),
    ]);
    return reply.header("cache-control", "no-store").send({ ...status, canRide });
  });

  // ─── Admin Settings ─────────────────────────────────────────────────────

  /** The stored setting, what is in force now, and how many riders have early access. */
  app.get("/admin/launch", { onRequest: [requireAuth, adminOnly], schema: SCHEMAS.admin }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const now = new Date();
    const [setting, status, earlyAccessRiders] = await Promise.all([
      readLaunchSetting(prisma),
      launchStatus(prisma, now),
      countEarlyAccess(prisma),
    ]);
    const updatedBy = setting.updatedBy
      ? await prisma.user.findUnique({ where: { id: setting.updatedBy }, select: { id: true, name: true } })
      : null;
    return reply.send({
      setting: {
        mode: setting.mode,
        launchAt: setting.launchAt?.toISOString() ?? null,
        updatedAt: setting.updatedAt?.toISOString() ?? null,
        updatedBy,
      },
      status,
      earlyAccessRiders,
    });
  });

  /** Body `{ mode, launchAt }`: launchAt (ISO) is needed for COUNTDOWN and must be in the future. */
  app.put("/admin/launch", { onRequest: [requireAuth, adminOnly], schema: SCHEMAS.setLaunch }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const body = request.body as { mode: LaunchMode; launchAt?: string | null };
    const launchAt = body.launchAt ? new Date(body.launchAt) : null;
    if (launchAt && Number.isNaN(launchAt.getTime())) {
      return reply.code(400).send({ error: "launchAt must be a date and time" });
    }
    try {
      await setLaunchMode(prisma, request.user!.userId, { mode: body.mode, launchAt });
    } catch (err) {
      if (err instanceof LaunchSettingError) return reply.code(400).send({ error: err.message });
      throw err;
    }
    request.log.info({ event: "launch_mode_changed", actor: request.user!.userId, mode: body.mode }, "Launch mode changed");
    return reply.send({ status: await launchStatus(prisma) });
  });

  /** `?phone=` in any spelling: the account and whether it has early access. Read-only, not logged. */
  app.get("/admin/early-access", { onRequest: [requireAuth, adminOnly], schema: SCHEMAS.lookUp }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const { phone: raw } = request.query as { phone: string };
    const phone = normalizePhone(raw);
    if (!phone) return reply.code(400).send({ error: "phone must be a Ghanaian number" });
    const account = await prisma.user.findFirst({ where: { phone, deletedAt: null }, select: ACCOUNT_SELECT });
    return reply.send({ phone, account });
  });

  /** Body `{ phone, enabled }`: gives (true) or takes away (false) one rider's early access. */
  app.post("/admin/early-access", { onRequest: [requireAuth, adminOnly], schema: SCHEMAS.setAccess }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const { phone: raw, enabled } = request.body as { phone: string; enabled: boolean };
    const phone = normalizePhone(raw);
    if (!phone) return reply.code(400).send({ error: "phone must be a Ghanaian number" });
    const account = await prisma.user.findFirst({ where: { phone, deletedAt: null }, select: ACCOUNT_SELECT });
    if (!account) return reply.code(404).send({ error: "No CampusRide account has that number" });
    if (account.role !== "RIDER") {
      return reply.code(400).send({
        error:
          account.role === "DRIVER"
            ? "That's a driver account. Drivers don't book rides; approved drivers can go online during the countdown already."
            : "Admin accounts can always book during the countdown.",
      });
    }
    await setEarlyAccess(prisma, request.user!.userId, account.id, enabled);
    const updated = await prisma.user.findUniqueOrThrow({ where: { id: account.id }, select: ACCOUNT_SELECT });
    return reply.send({ phone, account: updated });
  });

  /** "Give early access to all current riders": every open rider account that exists now. */
  app.post(
    "/admin/early-access/all-riders",
    { onRequest: [requireAuth, adminOnly], preValidation: bodyOptional, schema: SCHEMAS.grantAll },
    async (request, reply) => {
      if (!(await requireAdmin(request, reply))) return;
      const granted = await grantEarlyAccessToAllRiders(prisma, request.user!.userId);
      request.log.info({ event: "early_access_granted_all", actor: request.user!.userId, granted }, "Early access given to all current riders");
      return reply.send({ granted, earlyAccessRiders: await countEarlyAccess(prisma) });
    },
  );
}

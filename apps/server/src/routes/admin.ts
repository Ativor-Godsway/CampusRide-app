import type { FastifyInstance } from "fastify";
import type { PrismaClient, Prisma } from "@prisma/client";
import { requireAuth, requireAdmin } from "../middleware/auth";

/**
 * Phase 5 admin surface. Closes the gap where `Driver.isApproved` was enforced
 * by driver.ts / dispatch.ts / auth.ts but could only ever be SET by editing
 * the production database by hand.
 *
 * Every mutating route here writes an AdminAuditLog row inside the SAME
 * transaction as the change it records, so an approval can never exist
 * without an attributable actor.
 */

/** Explicit field list — same convention as routes/selects.ts: adding a column to Driver/User must not quietly publish it. */
const PENDING_DRIVER_SELECT = {
  id: true,
  carMake: true,
  carModel: true,
  carColor: true,
  plate: true,
  photoUrl: true,
  isApproved: true,
  createdAt: true,
  user: { select: { id: true, name: true, phone: true } },
} satisfies Prisma.DriverSelect;

const ADMIN_RIDE_SELECT = {
  id: true,
  status: true,
  type: true,
  source: true,
  occupancy: true,
  fareTotal: true,
  paymentStatus: true,
  paymentMethod: true,
  cancelReason: true,
  createdAt: true,
  completedAt: true,
  rider: { select: { id: true, name: true, phone: true } },
  driver: { select: { id: true, name: true, phone: true } },
  pickupZone: { select: { id: true, name: true } },
  dropoffZone: { select: { id: true, name: true } },
} satisfies Prisma.RideSelect;

const RIDE_STATUSES = [
  "REQUESTED",
  "MATCHED",
  "ARRIVED",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
  "AWAITING_RIDER_DECISION",
] as const;

const DEFAULT_RIDE_LIMIT = 50;
const MAX_RIDE_LIMIT = 200;

function parseLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_RIDE_LIMIT;
  return Math.min(Math.floor(n), MAX_RIDE_LIMIT);
}

/** Returns the parsed date, or null when absent; throws on an unparseable value. */
function parseDate(raw: unknown, field: string): Date | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const date = new Date(String(raw));
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${field} must be an ISO date`);
  }
  return date;
}

export function registerAdminRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  /** Drivers awaiting a decision: everything still sitting at isApproved=false. */
  app.get("/admin/drivers/pending", { preHandler: requireAuth }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;

    const drivers = await prisma.driver.findMany({
      where: { isApproved: false, user: { deletedAt: null } },
      select: PENDING_DRIVER_SELECT,
      orderBy: { createdAt: "asc" },
    });

    return reply.send({ drivers });
  });

  app.post("/admin/drivers/:id/approve", { preHandler: requireAuth }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;

    const { id } = request.params as { id: string };
    const driver = await prisma.driver.findUnique({ where: { id }, select: { id: true } });
    if (!driver) {
      return reply.code(404).send({ error: "Driver not found" });
    }

    const [updated] = await prisma.$transaction([
      prisma.driver.update({
        where: { id },
        data: { isApproved: true },
        select: PENDING_DRIVER_SELECT,
      }),
      prisma.adminAuditLog.create({
        data: { actor: request.user!.userId, action: "driver.approve", target: id },
      }),
    ]);

    return reply.send({ driver: updated });
  });

  /**
   * Rejection is not just "leave isApproved false": it also forces the driver
   * OFFLINE. Rejecting an already-approved driver has to take effect
   * immediately, and an online driver who stays online would keep receiving
   * dispatches until they happened to toggle off.
   */
  app.post("/admin/drivers/:id/reject", { preHandler: requireAuth }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;

    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { reason?: unknown };
    if (body.reason !== undefined && typeof body.reason !== "string") {
      return reply.code(400).send({ error: "reason must be a string" });
    }
    const reason = typeof body.reason === "string" && body.reason.trim().length > 0
      ? body.reason.trim()
      : null;

    const driver = await prisma.driver.findUnique({ where: { id }, select: { id: true } });
    if (!driver) {
      return reply.code(404).send({ error: "Driver not found" });
    }

    const [updated] = await prisma.$transaction([
      prisma.driver.update({
        where: { id },
        data: { isApproved: false, isOnline: false },
        select: PENDING_DRIVER_SELECT,
      }),
      prisma.adminAuditLog.create({
        data: { actor: request.user!.userId, action: "driver.reject", target: id, reason },
      }),
    ]);

    return reply.send({ driver: updated });
  });

  /**
   * Basic oversight list. v1 filters: status, and a createdAt window
   * (from/to). Read-only, so no audit row — the log records decisions, not
   * every page view.
   */
  app.get("/admin/rides", { preHandler: requireAuth }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;

    const query = request.query as { status?: unknown; from?: unknown; to?: unknown; limit?: unknown };

    if (query.status !== undefined && !(RIDE_STATUSES as readonly string[]).includes(String(query.status))) {
      return reply.code(400).send({ error: `status must be one of ${RIDE_STATUSES.join(", ")}` });
    }

    let from: Date | null;
    let to: Date | null;
    try {
      from = parseDate(query.from, "from");
      to = parseDate(query.to, "to");
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }

    const where: Prisma.RideWhereInput = {};
    if (query.status !== undefined) {
      where.status = String(query.status) as Prisma.RideWhereInput["status"];
    }
    if (from || to) {
      where.createdAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
    }

    const rides = await prisma.ride.findMany({
      where,
      select: ADMIN_RIDE_SELECT,
      orderBy: { createdAt: "desc" },
      take: parseLimit(query.limit),
    });

    return reply.send({ rides });
  });
}

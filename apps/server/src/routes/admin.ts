import type { FastifyInstance } from "fastify";
import type { PrismaClient, Prisma } from "@prisma/client";
import {
  FLAGGED_RIDER_CANCEL_REASONS,
  PLACE_CATEGORIES,
  RIDER_CANCEL_REASON_LABELS,
  isInServiceArea,
  nearestZone,
  searchPlaces,
  type PlaceCategory,
} from "@rida/shared";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { getActiveZones } from "../services/zones/zoneCache";
import { clearPlaceCache } from "../services/places/placeCache";

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
  riderCancelReason: true,
  riderCancelNote: true,
  createdAt: true,
  completedAt: true,
  rider: { select: { id: true, name: true, phone: true } },
  driver: { select: { id: true, name: true, phone: true } },
  pickupZone: { select: { id: true, name: true } },
  dropoffZone: { select: { id: true, name: true } },
  // Admins may see exact pins (support, disputes).
  pickupLat: true,
  pickupLng: true,
  pickupLabel: true,
  dropoffLat: true,
  dropoffLng: true,
  dropoffLabel: true,
  pickupNote: true,
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

const ADMIN_PLACE_SELECT = {
  id: true,
  name: true,
  aliases: true,
  latitude: true,
  longitude: true,
  category: true,
  zoneId: true,
  isActive: true,
  source: true,
  updatedAt: true,
  zone: { select: { name: true } },
} satisfies Prisma.PlaceSelect;

const PLACE_NAME_MAX = 120;
const ALIAS_MAX = 40;
const ALIASES_MAX = 10;

type PlaceInput = {
  name?: string;
  aliases?: string[];
  latitude?: number;
  longitude?: number;
  category?: PlaceCategory;
  isActive?: boolean;
};

/**
 * Validates a place body. `partial` (PATCH) allows any subset; otherwise
 * name, latitude and longitude are required. A position must be inside the
 * service area — a place nobody may book to is no use.
 */
function parsePlaceInput(body: unknown, partial: boolean): PlaceInput | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const out: PlaceInput = {};
  if (b.name !== undefined || !partial) {
    if (typeof b.name !== "string" || !b.name.trim()) return { error: "name is required" };
    if (b.name.trim().length > PLACE_NAME_MAX) return { error: `name must be at most ${PLACE_NAME_MAX} characters` };
    out.name = b.name.trim().replace(/\s+/g, " ");
  }
  if (b.aliases !== undefined) {
    if (!Array.isArray(b.aliases) || !b.aliases.every((a) => typeof a === "string")) {
      return { error: "aliases must be a list of words" };
    }
    const aliases = [...new Set((b.aliases as string[]).map((a) => a.trim()).filter(Boolean))];
    if (aliases.length > ALIASES_MAX || aliases.some((a) => a.length > ALIAS_MAX)) {
      return { error: `at most ${ALIASES_MAX} aliases of up to ${ALIAS_MAX} characters` };
    }
    out.aliases = aliases;
  }
  const moving = b.latitude !== undefined || b.longitude !== undefined;
  if (moving || !partial) {
    const { latitude, longitude } = b;
    if (typeof latitude !== "number" || typeof longitude !== "number" || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return { error: "latitude and longitude must both be numbers" };
    }
    if (!isInServiceArea({ latitude, longitude })) return { error: "That spot is outside the CampusRide service area" };
    out.latitude = latitude;
    out.longitude = longitude;
  }
  if (b.category !== undefined) {
    if (!(PLACE_CATEGORIES as readonly unknown[]).includes(b.category)) {
      return { error: `category must be one of ${PLACE_CATEGORIES.join(", ")}` };
    }
    out.category = b.category as PlaceCategory;
  }
  if (b.isActive !== undefined) {
    if (typeof b.isActive !== "boolean") return { error: "isActive must be true or false" };
    out.isActive = b.isActive;
  }
  return out;
}

/** "name: Balme → Balme Library; moved 42 m" — what the audit row says changed. */
function describePlaceChange(
  before: { name: string; aliases: string[]; latitude: number; longitude: number; category: string; isActive: boolean },
  after: PlaceInput,
): string {
  const parts: string[] = [];
  if (after.name !== undefined && after.name !== before.name) parts.push(`name: ${before.name} → ${after.name}`);
  if (after.aliases !== undefined && after.aliases.join("|") !== before.aliases.join("|")) {
    parts.push(`aliases: [${before.aliases.join(", ")}] → [${after.aliases.join(", ")}]`);
  }
  if (after.latitude !== undefined && (after.latitude !== before.latitude || after.longitude !== before.longitude)) {
    parts.push(`moved: ${before.latitude},${before.longitude} → ${after.latitude},${after.longitude}`);
  }
  if (after.category !== undefined && after.category !== before.category) parts.push(`category: ${before.category} → ${after.category}`);
  if (after.isActive !== undefined && after.isActive !== before.isActive) parts.push(after.isActive ? "reactivated" : "deactivated");
  return parts.join("; ");
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

    // The readable label and the "driver problem" flag come from
    // @rida/shared, so the admin site never keeps its own copy.
    return reply.send({
      rides: rides.map((ride) => ({
        ...ride,
        riderCancelReasonLabel: ride.riderCancelReason
          ? RIDER_CANCEL_REASON_LABELS[ride.riderCancelReason]
          : null,
        riderCancelFlagged:
          ride.riderCancelReason !== null &&
          FLAGGED_RIDER_CANCEL_REASONS.includes(ride.riderCancelReason),
      })),
    });
  });

  // ─── Campus places ───────────────────────────────────────────────────────
  //
  // Every change is audit-logged in the same transaction ("place.create",
  // "place.update", "place.move", "place.deactivate", "place.reactivate"),
  // with what changed in `reason`. Places are never deleted: a ride keeps
  // its own copy of the name and pin, and deactivating hides a place from
  // search without touching history. A move recomputes the place's zone.

  /** Every place, inactive ones too. `?q=` searches names and aliases the way riders do (typos and all). */
  app.get("/admin/places", { preHandler: requireAuth }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const { q } = (request.query ?? {}) as { q?: unknown };
    const query = typeof q === "string" ? q.trim().slice(0, 80) : "";
    const all = await prisma.place.findMany({
      select: ADMIN_PLACE_SELECT,
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
    });
    return reply.send({ places: query ? searchPlaces(all, query, all.length) : all });
  });

  app.post("/admin/places", { preHandler: requireAuth }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const input = parsePlaceInput(request.body, false);
    if ("error" in input) return reply.code(400).send({ error: input.error });

    const zone = nearestZone(input.latitude!, input.longitude!, await getActiveZones(prisma));
    if (!zone) return reply.code(409).send({ error: "No zones exist yet" });

    const place = await prisma.$transaction(async (tx) => {
      const created = await tx.place.create({
        data: {
          name: input.name!,
          aliases: input.aliases ?? [],
          latitude: input.latitude!,
          longitude: input.longitude!,
          category: input.category ?? "OTHER",
          isActive: input.isActive ?? true,
          zoneId: zone.id,
        },
        select: ADMIN_PLACE_SELECT,
      });
      await tx.adminAuditLog.create({
        data: {
          actor: request.user!.userId,
          action: "place.create",
          target: created.id,
          reason: `${created.name} at ${created.latitude},${created.longitude}`,
        },
      });
      return created;
    });
    clearPlaceCache(prisma);
    return reply.code(201).send({ place });
  });

  app.patch("/admin/places/:id", { preHandler: requireAuth }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const { id } = request.params as { id: string };
    const input = parsePlaceInput(request.body, true);
    if ("error" in input) return reply.code(400).send({ error: input.error });

    const before = await prisma.place.findUnique({ where: { id } });
    if (!before) return reply.code(404).send({ error: "Place not found" });

    const change = describePlaceChange(before, input);
    if (!change) {
      const place = await prisma.place.findUniqueOrThrow({ where: { id }, select: ADMIN_PLACE_SELECT });
      return reply.send({ place });
    }

    const moved = input.latitude !== undefined && (input.latitude !== before.latitude || input.longitude !== before.longitude);
    const zone = moved
      ? nearestZone(input.latitude!, input.longitude!, await getActiveZones(prisma))
      : null;
    const action =
      input.isActive === false && before.isActive
        ? "place.deactivate"
        : input.isActive === true && !before.isActive
          ? "place.reactivate"
          : moved && Object.keys(input).every((k) => k === "latitude" || k === "longitude")
            ? "place.move"
            : "place.update";

    const [place] = await prisma.$transaction([
      prisma.place.update({
        where: { id },
        data: { ...input, ...(zone ? { zoneId: zone.id } : {}) },
        select: ADMIN_PLACE_SELECT,
      }),
      prisma.adminAuditLog.create({
        data: { actor: request.user!.userId, action, target: id, reason: change.slice(0, 1000) },
      }),
    ]);
    clearPlaceCache(prisma);
    return reply.send({ place });
  });
}

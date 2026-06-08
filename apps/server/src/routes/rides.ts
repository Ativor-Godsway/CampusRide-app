import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { RideStatus, RideType } from "@rida/shared";
import { requireAuth } from "../middleware/auth";

const RIDE_TYPES = ["LONE", "SHARED"] as const;

// Rides in any of these statuses count as "active" — a rider may have at
// most one at a time.
const ACTIVE_RIDE_STATUSES: RideStatus[] = [
  "REQUESTED",
  "MATCHED",
  "ARRIVED",
  "IN_PROGRESS",
  "AWAITING_RIDER_DECISION",
];

function isRideType(value: unknown): value is RideType {
  return typeof value === "string" && (RIDE_TYPES as readonly string[]).includes(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Minimal ride-creation route for Phase 5b: the rider picks pickup/dropoff
 * zones and a ride type, and this creates a REQUESTED ride for the
 * dispatch/matching engine (Phase 2) to pick up. Reuses the existing
 * RideStatus/broadcastStartedAt conventions from rideService — no matching
 * logic is reimplemented here.
 */
export function registerRideRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  app.post("/rides", { preHandler: requireAuth }, async (request, reply) => {
    const body = request.body as {
      pickupZoneId?: unknown;
      dropoffZoneId?: unknown;
      type?: unknown;
    };

    if (
      !isNonEmptyString(body.pickupZoneId) ||
      !isNonEmptyString(body.dropoffZoneId) ||
      !isRideType(body.type)
    ) {
      return reply
        .code(400)
        .send({ error: "pickupZoneId, dropoffZoneId, and type (LONE|SHARED) are required" });
    }

    if (body.pickupZoneId === body.dropoffZoneId) {
      return reply.code(400).send({ error: "pickupZoneId and dropoffZoneId must differ" });
    }

    const [pickupZone, dropoffZone] = await Promise.all([
      prisma.zone.findUnique({ where: { id: body.pickupZoneId } }),
      prisma.zone.findUnique({ where: { id: body.dropoffZoneId } }),
    ]);

    if (!pickupZone || !dropoffZone) {
      return reply.code(404).send({ error: "pickupZoneId or dropoffZoneId not found" });
    }

    const riderId = request.user!.userId;

    const existingActiveRide = await prisma.ride.findFirst({
      where: { riderId, status: { in: ACTIVE_RIDE_STATUSES } },
    });

    if (existingActiveRide) {
      return reply.code(409).send({ error: "You already have an active ride", ride: existingActiveRide });
    }

    const ride = await prisma.ride.create({
      data: {
        riderId,
        type: body.type,
        status: "REQUESTED",
        pickupZoneId: body.pickupZoneId,
        dropoffZoneId: body.dropoffZoneId,
        occupancy: 1,
        broadcastStartedAt: new Date(),
      },
    });

    return reply.code(201).send({ ride });
  });
}

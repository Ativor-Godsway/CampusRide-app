import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { RideStatus, RideType } from "@rida/shared";
import { getLoneFare, getSharedFarePerRider } from "@rida/shared";
import { requireAuth } from "../middleware/auth";
import { applyRideTransition } from "../services/ride/rideService";
import { riderDecision, type RiderDecisionAction } from "../services/ride/riderDecision";
import { InvalidSwitchToLoneError, InvalidTransitionError } from "../services/ride/errors";
import { emitRideEvent } from "../realtime/rideSocket";
import { config } from "../config";
import { startMockDriverForRide } from "../dev/mockDriver";

const RIDE_TYPES = ["LONE", "SHARED"] as const;
const DECISION_ACTIONS: readonly RiderDecisionAction[] = ["KEEP_WAITING", "SWITCH_TO_LONE", "CANCEL"];

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

function isDecisionAction(value: unknown): value is RiderDecisionAction {
  return typeof value === "string" && (DECISION_ACTIONS as readonly string[]).includes(value);
}

/** Statuses from which a rider can still cancel (IN_PROGRESS is the point of no return). */
const RIDER_CANCELLABLE_STATUSES: RideStatus[] = [
  "REQUESTED",
  "MATCHED",
  "ARRIVED",
  "AWAITING_RIDER_DECISION",
];

/**
 * Driver info shaped like the `ride:driver_assigned` socket payload (minus
 * rideId) — used both for that event and for GET /rides/:id so a rider who
 * reconnects/reloads after the assignment sees the same shape.
 */
async function getDriverInfo(prisma: PrismaClient, driverId: string) {
  const driver = await prisma.user.findUnique({ where: { id: driverId }, include: { driver: true } });
  if (!driver) return null;

  const { _avg } = await prisma.rating.aggregate({
    where: { rateeId: driverId },
    _avg: { stars: true },
  });

  return {
    driverId: driver.id,
    name: driver.name,
    carMake: driver.driver?.carMake ?? null,
    carModel: driver.driver?.carModel ?? null,
    carColor: driver.driver?.carColor ?? null,
    plate: driver.driver?.plate ?? null,
    rating: _avg.stars ?? null,
  };
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

    const lockedFare = body.type === "SHARED" ? getSharedFarePerRider(1) : getLoneFare();

    const ride = await prisma.ride.create({
      data: {
        riderId,
        type: body.type,
        status: "REQUESTED",
        pickupZoneId: body.pickupZoneId,
        dropoffZoneId: body.dropoffZoneId,
        occupancy: 1,
        broadcastStartedAt: new Date(),
        passengers: {
          create: {
            riderId,
            pickupZoneId: body.pickupZoneId,
            dropoffZoneId: body.dropoffZoneId,
            status: "WAITING",
            lockedFare,
          },
        },
      },
      include: { passengers: true },
    });

    if (config.enableMockDriver) {
      startMockDriverForRide(prisma, ride.id);
    }

    return reply.code(201).send({ ride });
  });

  app.get("/rides/:id", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const ride = await prisma.ride.findUnique({
      where: { id },
      include: { pickupZone: true, dropoffZone: true, passengers: true },
    });

    if (!ride) {
      return reply.code(404).send({ error: "Ride not found" });
    }

    const userId = request.user!.userId;
    const isRider = ride.riderId === userId;
    const isPassenger = ride.passengers.some((p) => p.riderId === userId);

    if (!isRider && !isPassenger) {
      return reply.code(403).send({ error: "Forbidden" });
    }

    const driver = ride.driverId ? await getDriverInfo(prisma, ride.driverId) : null;

    return reply.code(200).send({ ride, driver });
  });

  app.post("/rides/:id/decision", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { action?: unknown };

    if (!isDecisionAction(body.action)) {
      return reply
        .code(400)
        .send({ error: "action must be one of KEEP_WAITING | SWITCH_TO_LONE | CANCEL" });
    }

    const ride = await prisma.ride.findUnique({ where: { id } });
    if (!ride) {
      return reply.code(404).send({ error: "Ride not found" });
    }
    if (ride.riderId !== request.user!.userId) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    if (ride.status !== "AWAITING_RIDER_DECISION") {
      return reply.code(409).send({ error: "Ride is not awaiting a decision" });
    }

    try {
      const updated = await riderDecision(prisma, id, body.action);
      emitRideEvent(id, "ride:status", { rideId: id, status: updated.status });

      if (config.enableMockDriver && updated.status === "REQUESTED") {
        startMockDriverForRide(prisma, id);
      }

      return reply.code(200).send({ ride: updated });
    } catch (err) {
      if (err instanceof InvalidSwitchToLoneError) {
        return reply.code(409).send({ error: err.message });
      }
      throw err;
    }
  });

  app.post("/rides/:id/cancel", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const ride = await prisma.ride.findUnique({ where: { id } });
    if (!ride) {
      return reply.code(404).send({ error: "Ride not found" });
    }
    if (ride.riderId !== request.user!.userId) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    if (!RIDER_CANCELLABLE_STATUSES.includes(ride.status as RideStatus)) {
      return reply.code(409).send({ error: "Ride can no longer be cancelled" });
    }

    try {
      const updated = await applyRideTransition(prisma, id, "CANCELLED", {
        cancelReason: "RIDER_CANCELLED",
      });
      emitRideEvent(id, "ride:status", { rideId: id, status: updated.status });
      return reply.code(200).send({ ride: updated });
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        return reply.code(409).send({ error: "Ride can no longer be cancelled" });
      }
      throw err;
    }
  });
}

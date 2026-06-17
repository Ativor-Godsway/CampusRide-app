import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { PaymentMethod, RideStatus, RideType } from "@rida/shared";
import { getLoneFare, getSharedFarePerRider } from "@rida/shared";
import { requireAuth } from "../middleware/auth";
import { applyRideTransition } from "../services/ride/rideService";
import { riderDecision, type RiderDecisionAction } from "../services/ride/riderDecision";
import { InvalidSwitchToLoneError, InvalidTransitionError } from "../services/ride/errors";
import { emitRideEvent } from "../realtime/rideSocket";
import { broadcastRide } from "../services/ride/dispatch";
import { getRidePaymentSummary, initiateCollection } from "../services/payment/paymentFlow";
import type { MoolreChannel } from "../services/payment/constants";
import { paymentService } from "../services/active";
import { config } from "../config";
import { startMockDriverForRide } from "../dev/mockDriver";

const RIDE_TYPES = ["LONE", "SHARED"] as const;
const PAYMENT_METHODS = ["CASH", "MOMO"] as const;
const MOOLRE_CHANNELS = ["MTN", "TELECEL", "AT"] as const;
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

function isPaymentMethod(value: unknown): value is PaymentMethod {
  return typeof value === "string" && (PAYMENT_METHODS as readonly string[]).includes(value);
}

function isMoolreChannel(value: unknown): value is MoolreChannel {
  return typeof value === "string" && (MOOLRE_CHANNELS as readonly string[]).includes(value);
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
  const [driver, { _avg }] = await Promise.all([
    prisma.user.findUnique({ where: { id: driverId }, include: { driver: true } }),
    prisma.rating.aggregate({ where: { rateeId: driverId }, _avg: { stars: true } }),
  ]);
  if (!driver) return null;

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
      paymentMethod?: unknown;
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

    const paymentMethod: PaymentMethod =
      isPaymentMethod(body.paymentMethod) ? body.paymentMethod : "MOMO";

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
        paymentMethod,
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

    // Notify eligible real drivers via socket (Phase 6a). Fire-and-forget.
    broadcastRide(prisma, ride.id).catch((err) => {
      console.error(`[broadcastRide] failed for ride ${ride.id}:`, err);
    });

    if (config.enableMockDriver) {
      startMockDriverForRide(prisma, ride.id);
    }

    return reply.code(201).send({ ride });
  });

  app.get("/rides/mine", { preHandler: requireAuth }, async (request, reply) => {
    const riderId = request.user!.userId;

    const rides = await prisma.ride.findMany({
      where: { riderId },
      include: { pickupZone: true, dropoffZone: true },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    return reply.code(200).send({ rides });
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

    // Include fare summary when COMPLETED so polling self-contains the full
    // completion signal (no socket required to show the rating/fare screen).
    let fareSummary:
      | {
          yourFarePesewas: number;
          totalFarePesewas: number;
          paymentMethod: PaymentMethod;
          paymentStatus: string;
        }
      | undefined;
    if (ride.status === "COMPLETED") {
      const summary = await getRidePaymentSummary(prisma, id);
      const yourShare = summary.perPassenger.find((p) => p.riderId === userId);
      fareSummary = {
        yourFarePesewas: yourShare?.farePesewas ?? 0,
        totalFarePesewas: summary.totalExpectedPesewas,
        paymentMethod: ride.paymentMethod as PaymentMethod,
        paymentStatus: yourShare?.status ?? "PENDING",
      };
    }

    return reply.code(200).send({ ride, driver, ...(fareSummary ? { fareSummary } : {}) });
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

      if (updated.status === "REQUESTED") {
        broadcastRide(prisma, id).catch((err) => {
          console.error(`[broadcastRide] failed for ride ${id}:`, err);
        });
        if (config.enableMockDriver) {
          startMockDriverForRide(prisma, id);
        }
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

  /**
   * Rider initiates MOMO payment for their completed ride leg.
   * Body: { phone: string; network: "MTN" | "TELECEL" | "AT" }
   * Idempotent — calling again with the same ride/rider returns the existing
   * Payment row without re-charging the rider.
   */
  app.post("/rides/:id/initiate-payment", { preHandler: requireAuth }, async (request, reply) => {
    const { id: rideId } = request.params as { id: string };
    const userId = request.user!.userId;
    const body = request.body as { phone?: unknown; network?: unknown };

    if (!isNonEmptyString(body.phone) || !isMoolreChannel(body.network)) {
      return reply.code(400).send({ error: "phone and network (MTN|TELECEL|AT) are required" });
    }

    const ride = await prisma.ride.findUnique({
      where: { id: rideId },
      include: { passengers: true },
    });
    if (!ride) return reply.code(404).send({ error: "Ride not found" });

    const isRider = ride.riderId === userId;
    const passenger = ride.passengers.find((p) => p.riderId === userId);
    if (!isRider && !passenger) return reply.code(403).send({ error: "Forbidden" });
    if (ride.status !== "COMPLETED") {
      return reply.code(409).send({ error: "Ride is not yet completed" });
    }
    if (ride.paymentMethod !== "MOMO") {
      return reply.code(409).send({ error: "Payment method is not MOMO" });
    }

    const amountPesewas = passenger?.lockedFare ?? null;
    if (amountPesewas == null) {
      return reply.code(409).send({ error: "No fare recorded for this rider" });
    }

    const payment = await initiateCollection(prisma, paymentService, {
      rideId,
      riderId: userId,
      amountPesewas,
      payerPhone: body.phone,
      channel: body.network,
    });

    return reply.code(200).send({ paymentStatus: payment.status });
  });

  /** Poll the rider's Moolre payment status for a completed MOMO ride. */
  app.get("/rides/:id/payment-status", { preHandler: requireAuth }, async (request, reply) => {
    const { id: rideId } = request.params as { id: string };
    const userId = request.user!.userId;

    const ride = await prisma.ride.findUnique({
      where: { id: rideId },
      include: { passengers: true },
    });
    if (!ride) return reply.code(404).send({ error: "Ride not found" });

    const isRider = ride.riderId === userId;
    const isPassenger = ride.passengers.some((p) => p.riderId === userId);
    if (!isRider && !isPassenger) return reply.code(403).send({ error: "Forbidden" });

    const summary = await getRidePaymentSummary(prisma, rideId);
    const yours = summary.perPassenger.find((p) => p.riderId === userId);

    return reply.code(200).send({
      paymentStatus: yours?.status ?? "PENDING",
      paymentMethod: ride.paymentMethod as PaymentMethod,
    });
  });
}

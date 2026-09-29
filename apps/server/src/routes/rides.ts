import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { PaymentMethod, RideStatus, RideType } from "@rida/shared";
import { FLAGGED_RIDER_CANCEL_REASONS, parseRiderCancelInput } from "@rida/shared";
import { requireAuth } from "../middleware/auth";
import { applyRideTransition } from "../services/ride/rideService";
import { riderDecision, type RiderDecisionAction } from "../services/ride/riderDecision";
import { InvalidTransitionError, RideSwitchNotAllowedError } from "../services/ride/errors";
import { fareForType, switchRideType } from "../services/ride/switchRideType";
import { findActiveRideForRider } from "../services/ride/activeRide";
import { emitRideEvent } from "../realtime/rideSocket";
import { broadcastRide } from "../services/ride/dispatch";
import {
  createRide,
  ActiveRideExistsError,
  SameZoneError,
  ZoneNotFoundError,
} from "../services/ride/createRide";
import { getRidePaymentSummary, initiateCollection } from "../services/payment/paymentFlow";
import { NoAwaitingOtpPaymentError } from "../services/payment/errors";
import type { MoolreChannel } from "../services/payment/constants";
import { paymentService } from "../services/active";
import { config } from "../config";
import { getDriverInfo } from "../services/user/driverInfo";
import { logger } from "../lib/logger";
import { riderRideDetailSelect, riderRideListSelect } from "./selects";
import { startMockDriverForRide } from "../dev/mockDriver";

/**
 * Shape returned by `POST /rides/:id/initiate-payment` while
 * `MOOLRE_ENABLED` is false (cash-only launch). `code` is the stable
 * machine-readable discriminator clients should branch on.
 */
export interface CashOnlyPaymentResponse {
  error: string;
  code: "PAYMENTS_CASH_ONLY";
  paymentMode: "CASH_ONLY";
}

const RIDE_TYPES = ["LONE", "SHARED"] as const;
const PAYMENT_METHODS = ["CASH", "MOMO"] as const;
const MOOLRE_CHANNELS = ["MTN", "TELECEL", "AT"] as const;
const DECISION_ACTIONS: readonly RiderDecisionAction[] = ["KEEP_WAITING", "SWITCH_TO_LONE", "CANCEL"];

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

async function requireRider(request: Parameters<typeof requireAuth>[0], reply: Parameters<typeof requireAuth>[1]): Promise<boolean> {
  if (request.user?.role !== "RIDER") {
    reply.code(403).send({ error: "Rider role required" });
    return false;
  }
  return true;
}

/**
 * Per-USER rate limit for a route behind requireAuth. Runs as a preHandler
 * so it comes after requireAuth has set request.user; keying on the user id
 * means one rider on a shared campus Wi-Fi IP can't use up everyone's quota,
 * and switching networks doesn't reset a rider's own.
 */
function perUserRateLimit(max: number) {
  return {
    rateLimit: {
      max,
      timeWindow: "15 minutes",
      hook: "preHandler" as const,
      keyGenerator: (request: FastifyRequest) => `user:${request.user?.userId ?? request.ip}`,
    },
  };
}

/** Statuses from which a rider can still cancel (IN_PROGRESS is the point of no return). */
const RIDER_CANCELLABLE_STATUSES: RideStatus[] = [
  "REQUESTED",
  "MATCHED",
  "ARRIVED",
  "AWAITING_RIDER_DECISION",
];

/**
 * Minimal ride-creation route for Phase 5b: the rider picks pickup/dropoff
 * zones and a ride type, and this creates a REQUESTED ride for the
 * dispatch/matching engine (Phase 2) to pick up. Reuses the existing
 * RideStatus/broadcastStartedAt conventions from rideService — no matching
 * logic is reimplemented here.
 */
export function registerRideRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  app.post(
    "/rides",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: config.rateLimit.rideCreateMax, timeWindow: "15 minutes" } },
    },
    async (request, reply) => {
    if (!(await requireRider(request, reply))) return;

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

    // Cash-only launch (Phase 1): an omitted/invalid paymentMethod falls back
    // to CASH, matching the schema default. Defaulting to MOMO here would
    // create a ride that initiate-payment now refuses to settle and that
    // finalizeRideCompletion would skip when writing the commission ledger.
    const paymentMethod: PaymentMethod =
      isPaymentMethod(body.paymentMethod) ? body.paymentMethod : "CASH";

    const riderId = request.user!.userId;

    let ride;
    try {
      ride = await createRide(prisma, {
        riderId,
        type: body.type,
        pickupZoneId: body.pickupZoneId,
        dropoffZoneId: body.dropoffZoneId,
        paymentMethod,
      });
    } catch (err) {
      if (err instanceof SameZoneError) {
        return reply.code(400).send({ error: err.message });
      }
      if (err instanceof ZoneNotFoundError) {
        return reply.code(404).send({ error: err.message });
      }
      if (err instanceof ActiveRideExistsError) {
        // activeRideId lets the app jump straight to the ride. `ride` is kept
        // for older app builds but is now just { id, status } — it used to be
        // the whole database row (tracking token and all).
        return reply.code(409).send({
          error: err.message,
          code: "ACTIVE_RIDE_EXISTS",
          activeRideId: err.existingRide.id,
          ride: { id: err.existingRide.id, status: err.existingRide.status },
        });
      }
      throw err;
    }

    if (config.enableMockDriver) {
      startMockDriverForRide(prisma, ride.id);
    }

    return reply.code(201).send({ ride });
  });

  app.get("/rides/mine", { preHandler: requireAuth }, async (request, reply) => {
    if (!(await requireRider(request, reply))) return;

    const riderId = request.user!.userId;

    /**
     * Cursor pagination (Phase 4). This used to hard-cap at the newest 50
     * rides with no way to reach anything older.
     *
     * Cursor over `id` rather than an offset: rides are ordered newest-first
     * by createdAt, and a rider creating a ride mid-scroll would shift every
     * offset by one, silently duplicating or skipping a row. A cursor is
     * stable against that. createdAt alone is not unique enough to page on,
     * so id is the tiebreaker and the cursor itself.
     */
    const query = (request.query ?? {}) as { cursor?: unknown; limit?: unknown };

    const DEFAULT_LIMIT = 20;
    const MAX_LIMIT = 50;
    const parsedLimit = Number(query.limit);
    const limit =
      Number.isInteger(parsedLimit) && parsedLimit > 0
        ? Math.min(parsedLimit, MAX_LIMIT)
        : DEFAULT_LIMIT;

    const cursor = isNonEmptyString(query.cursor) ? query.cursor : undefined;

    // Fetch one extra row to determine whether another page exists, without
    // paying for a second COUNT query over the rider's whole history.
    const rows = await prisma.ride.findMany({
      where: { riderId },
      select: riderRideListSelect,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const rides = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? rides[rides.length - 1]!.id : null;

    return reply.code(200).send({ rides, nextCursor, hasMore });
  });

  /**
   * The signed-in rider's ride that is still going on, or `{ ride: null }`.
   * The app calls it on launch, on returning from the background and while
   * a tab is open, so an active ride can never become unreachable (see
   * findActiveRideForRider for what counts, including merged riders).
   *
   * Pickup/drop-off are the rider's OWN (their seat's), which differ from
   * the ride's for a rider merged into someone else's car.
   */
  app.get("/rides/active", { preHandler: requireAuth }, async (request, reply) => {
    if (!(await requireRider(request, reply))) return;

    const active = await findActiveRideForRider(prisma, request.user!.userId);
    if (!active) return reply.code(200).send({ ride: null });

    const { ride, passenger } = active;
    const zoneSelect = { select: { id: true, name: true, latitude: true, longitude: true } } as const;
    const [pickupZone, dropoffZone, driverUser] = await Promise.all([
      prisma.zone.findUnique({ where: { id: passenger?.pickupZoneId ?? ride.pickupZoneId }, ...zoneSelect }),
      prisma.zone.findUnique({ where: { id: passenger?.dropoffZoneId ?? ride.dropoffZoneId }, ...zoneSelect }),
      ride.driverId
        ? prisma.user.findUnique({ where: { id: ride.driverId }, select: { name: true } })
        : Promise.resolve(null),
    ]);

    return reply.code(200).send({
      ride: {
        id: ride.id,
        status: ride.status,
        type: ride.type,
        /** This rider's own leg (null if they have no seat row). */
        legStatus: passenger?.status ?? null,
        pickupZone,
        dropoffZone,
        // First name only: all the banner needs ("Kofi is 3 min away").
        driver: driverUser ? { firstName: driverUser.name.trim().split(/\s+/)[0] ?? "" } : null,
      },
    });
  });

  app.get("/rides/:id", { preHandler: requireAuth }, async (request, reply) => {
    if (!(await requireRider(request, reply))) return;

    const { id } = request.params as { id: string };

    const ride = await prisma.ride.findUnique({
      where: { id },
      select: riderRideDetailSelect,
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

    // Pass the ride so the driver's phone drops out of the payload once the
    // trip has been finished for more than 24h (services/user/driverInfo.ts).
    const driver = ride.driverId ? await getDriverInfo(prisma, ride.driverId, ride) : null;

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
    if (!(await requireRider(request, reply))) return;

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
          logger.error("broadcastRide failed", { rideId: id, err });
        });
        if (config.enableMockDriver) {
          startMockDriverForRide(prisma, id);
        }
      }

      return reply.code(200).send({ ride: updated });
    } catch (err) {
      // Includes InvalidSwitchToLoneError (more than one rider in the car).
      if (err instanceof RideSwitchNotAllowedError) {
        return reply.code(409).send({ error: err.message });
      }
      throw err;
    }
  });

  /**
   * Rider cancels their own ride. Optional body `{ reason, note }` from the
   * app's cancel sheet (see parseRiderCancelInput): stored in
   * riderCancelReason / riderCancelNote, separate from the system
   * cancelReason, and written in the same update as the status change.
   */
  app.post(
    "/rides/:id/cancel",
    { preHandler: requireAuth, config: perUserRateLimit(config.rateLimit.rideCancelMax) },
    async (request, reply) => {
    if (!(await requireRider(request, reply))) return;

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

    const input = parseRiderCancelInput(request.body, { hasDriver: ride.driverId !== null });
    if (!input.ok) {
      return reply.code(400).send({ error: input.error });
    }

    try {
      const updated = await applyRideTransition(prisma, id, "CANCELLED", {
        cancelReason: "RIDER_CANCELLED",
        riderCancel: { reason: input.reason, note: input.note },
      });
      emitRideEvent(id, "ride:status", { rideId: id, status: updated.status });

      const flagged = input.reason !== null && FLAGGED_RIDER_CANCEL_REASONS.includes(input.reason);
      request.log[flagged ? "warn" : "info"](
        {
          event: "ride_cancelled_by_rider",
          rideId: id,
          driverId: ride.driverId,
          fromStatus: ride.status,
          riderCancelReason: input.reason,
          flagged,
        },
        flagged ? "Rider cancelled: driver asked them to cancel" : "Rider cancelled their ride",
      );
      return reply.code(200).send({ ride: updated });
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        return reply.code(409).send({ error: "Ride can no longer be cancelled" });
      }
      throw err;
    }
    },
  );

  /**
   * Rider switches a still-searching ride between Shared and Ride alone,
   * in place (see switchRideType). Body: `{ type: "LONE" | "SHARED" }`.
   * Allowed while REQUESTED or AWAITING_RIDER_DECISION, i.e. before any
   * driver holds the ride; the answer carries the ride's new locked fare.
   */
  app.post(
    "/rides/:id/switch",
    { preHandler: requireAuth, config: perUserRateLimit(config.rateLimit.rideSwitchMax) },
    async (request, reply) => {
      if (!(await requireRider(request, reply))) return;

      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { type?: unknown };
      if (body.type !== "LONE" && body.type !== "SHARED") {
        return reply.code(400).send({ error: "type must be LONE or SHARED" });
      }
      const toType: RideType = body.type;

      const ride = await prisma.ride.findUnique({ where: { id } });
      if (!ride) {
        return reply.code(404).send({ error: "Ride not found" });
      }
      if (ride.riderId !== request.user!.userId) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      try {
        const updated = await switchRideType(prisma, id, toType);
        emitRideEvent(id, "ride:status", { rideId: id, status: updated.status });
        broadcastRide(prisma, id).catch((err) => {
          logger.error("broadcastRide failed", { rideId: id, err });
        });
        if (config.enableMockDriver) {
          startMockDriverForRide(prisma, id);
        }
        request.log.info(
          { event: "ride_type_switched", rideId: id, fromType: ride.type, toType },
          "Rider switched ride type",
        );
        return reply.code(200).send({ ride: updated, farePesewas: fareForType(toType) });
      } catch (err) {
        if (err instanceof RideSwitchNotAllowedError) {
          return reply.code(409).send({ error: err.message, code: "RIDE_NOT_SWITCHABLE" });
        }
        throw err;
      }
    },
  );

  /**
   * Rider initiates MOMO payment for their completed ride leg, and (second
   * call) confirms an OTP if Moolre required one.
   * Body: { phone: string; network: "MTN" | "TELECEL" | "AT"; otpcode?: string }
   * otpcode is only sent on the confirmation call, after the first response's
   * otpStage is "OTP_SENT" or "OTP_RETRY". The client must echo the SAME
   * phone/network it sent on the first call — they're not persisted, and are
   * passed straight through to Moolre's re-call.
   * Idempotent — calling again with the same ride/rider (no otpcode) returns
   * the existing Payment row without re-charging the rider.
   */
  app.post(
    "/rides/:id/initiate-payment",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: config.rateLimit.paymentInitMax, timeWindow: "15 minutes" } },
    },
    async (request, reply) => {
    if (!(await requireRider(request, reply))) return;

    // Cash-only lockdown (Phase 1). With Moolre disabled there is no live
    // collection provider: the old fall-through landed on DummyPaymentService,
    // whose collect() returns a PROMPT_SENT/PENDING outcome that nothing in
    // production ever resolves — the rider's "Pay" tap hung forever. Fail
    // closed with an explicit, typed answer instead, BEFORE any Payment row is
    // created. Checked first so the answer doesn't depend on ride state.
    if (!config.moolre.paymentsEnabled) {
      return reply.code(409).send({
        error: "Digital payments are disabled — please pay the driver in cash.",
        code: "PAYMENTS_CASH_ONLY",
        paymentMode: "CASH_ONLY",
      } satisfies CashOnlyPaymentResponse);
    }

    const { id: rideId } = request.params as { id: string };
    const userId = request.user!.userId;
    const body = request.body as { phone?: unknown; network?: unknown; otpcode?: unknown };

    if (!isNonEmptyString(body.phone) || !isMoolreChannel(body.network)) {
      return reply.code(400).send({ error: "phone and network (MTN|TELECEL|AT) are required" });
    }
    if (body.otpcode !== undefined && !isNonEmptyString(body.otpcode)) {
      return reply.code(400).send({ error: "otpcode must be a non-empty string if provided" });
    }
    const otpcode = body.otpcode as string | undefined;

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

    let payment;
    try {
      payment = await initiateCollection(prisma, paymentService, {
        rideId,
        riderId: userId,
        amountPesewas,
        payerPhone: body.phone,
        channel: body.network,
        otpcode,
      });
    } catch (err) {
      if (err instanceof NoAwaitingOtpPaymentError) {
        return reply.code(409).send({ error: "No pending OTP confirmation for this ride" });
      }
      throw err;
    }

    const otpStage =
      payment.status === "AWAITING_OTP"
        ? (otpcode != null ? "OTP_RETRY" : "OTP_SENT")
        : payment.status === "PENDING" || payment.status === "PROMPT_PENDING"
          ? "SUBMITTED"
          : null;

    return reply.code(200).send({ paymentStatus: payment.status, otpStage });
  });

  /** Poll the rider's Moolre payment status for a completed MOMO ride. */
  app.get("/rides/:id/payment-status", { preHandler: requireAuth }, async (request, reply) => {
    if (!(await requireRider(request, reply))) return;

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

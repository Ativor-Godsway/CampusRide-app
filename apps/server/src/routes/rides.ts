import type { FastifyInstance } from "fastify";
import { useRequestValidation } from "../http/validation";
import type { PrismaClient } from "@prisma/client";
import type { PassengerStatus, PaymentMethod, RideStatus, RideType } from "@rida/shared";
import {
  FLAGGED_RIDER_CANCEL_REASONS,
  RIDER_CANCEL_REASONS,
  parsePickupNote,
  parseRiderCancelInput,
} from "@rida/shared";
import { requireAuth } from "../middleware/auth";
import { applyPassengerTransition, applyRideTransition } from "../services/ride/rideService";
import { isActivePassengerStatus } from "../services/ride/stateMachine";
import { riderDecision, type RiderDecisionAction } from "../services/ride/riderDecision";
import { InvalidTransitionError, RideSwitchNotAllowedError } from "../services/ride/errors";
import { fareForType, switchRideType } from "../services/ride/switchRideType";
import { findActiveRideForRider } from "../services/ride/activeRide";
import { emitRideEvent, emitToRider, removeRiderFromRide } from "../realtime/rideSocket";
import { broadcastRide, closeOffer } from "../services/ride/dispatch";
import {
  createRide,
  ActiveRideExistsError,
  SameZoneError,
  TripTooShortError,
  ZoneNotFoundError,
  ZoneRetiredError,
} from "../services/ride/createRide";
import {
  OutsideServiceAreaError,
  PlaceNotFoundError,
  parseRideEndInput,
  type RideEndInput,
} from "../services/places/rideEnds";
import { hideOtherRidersPins, pinFieldsOf } from "./ridePins";
import { getRidePaymentSummary, initiateCollection } from "../services/payment/paymentFlow";
import { NoAwaitingOtpPaymentError } from "../services/payment/errors";
import type { MoolreChannel } from "../services/payment/constants";
import { paymentService } from "../services/active";
import { config } from "../config";
import { getDriverInfo } from "../services/user/driverInfo";
import { logger } from "../lib/logger";
import { riderRideDetailSelect, riderRideListSelect } from "./selects";
import { startMockDriverForRide } from "../dev/mockDriver";
import { RULES } from "../rateLimit/rules";
import {
  MAX,
  bodyOptional,
  empty,
  id,
  idParams,
  latitude,
  longitude,
  noInput,
  object,
  oneOf,
  phone as phoneField,
  text,
} from "../http/schemas";
import { notifyRiderCancelled } from "../services/push/notify";
import { LaunchNotOpenError } from "../services/launch/launchSettings";

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

/** A pickup or drop-off: a campus place, a pin, or both (the parsers check which combinations make sense). */
const rideEnd = object({ placeId: id, latitude, longitude });

/** Request schemas (http/schemas.ts): unknown fields are dropped before the handler. */
const SCHEMAS = {
  create: {
    body: object(
      {
        pickup: rideEnd,
        dropoff: rideEnd,
        pickupZoneId: id,
        dropoffZoneId: id,
        type: oneOf(RIDE_TYPES),
        pickupNote: text(MAX.freeText, { nullable: true }),
        // Not an enum on purpose: anything but MOMO falls back to CASH (cash-only launch).
        paymentMethod: text(20),
      },
      ["type"],
    ),
  },
  // limit is read leniently by the handler (junk ignored, too big capped).
  mine: { querystring: object({ cursor: id, limit: text(20) }) },
  active: noInput,
  detail: { params: idParams, querystring: empty },
  decision: { params: idParams, body: object({ action: oneOf(DECISION_ACTIONS) }, ["action"]) },
  cancel: {
    params: idParams,
    body: object({ reason: oneOf(RIDER_CANCEL_REASONS, { nullable: true }), note: text(MAX.freeText, { nullable: true }) }),
  },
  switch: { params: idParams, body: object({ type: oneOf(RIDE_TYPES) }, ["type"]) },
  initiatePayment: {
    params: idParams,
    // Not required here: the "payments are off, pay cash" answer must come
    // before any field is checked; the handler checks them after it.
    body: object({ phone: phoneField, network: oneOf(MOOLRE_CHANNELS), otpcode: text(MAX.otpCode, { nonEmpty: true }) }),
  },
  paymentStatus: { params: idParams, querystring: empty },
};

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
 * A ride that isn't the caller's gets exactly the answer a ride that doesn't
 * exist gets, so trying ids confirms nothing about other people's rides.
 */
function rideNotFound(reply: Parameters<typeof requireAuth>[1]) {
  return reply.code(404).send({ error: "Ride not found" });
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
 *
 * Body, current apps: `{ pickup, dropoff, type, pickupNote?, paymentMethod? }`
 * where each end is `{ placeId }`, `{ latitude, longitude }` or both (a
 * place whose pin the rider moved). Older builds send pickupZoneId /
 * dropoffZoneId instead, and get exactly the ride they always did. Refusals:
 * 422 OUTSIDE_SERVICE_AREA, 404 PLACE_NOT_FOUND, 400 TRIP_TOO_SHORT /
 * NOTE_TOO_LONG — each with `error` in words the app can show as-is.
 * 422 LAUNCH_NOT_OPEN during the launch countdown: a 400/404/422 with a code
 * and an error is what every app build since exact pins shows in its own
 * words ("CampusRide opens on …"), so older builds need no update for it.
 */
export function registerRideRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  useRequestValidation(app);
  app.post(
    "/rides",
    {
      onRequest: requireAuth,
      schema: SCHEMAS.create,
      // Per rider, on top of the one-active-ride rule (createRide).
      config: { limits: { user: [RULES.rideCreate] } },
    },
    async (request, reply) => {
    if (!(await requireRider(request, reply))) return;

    const body = (request.body ?? {}) as {
      pickupZoneId?: unknown;
      dropoffZoneId?: unknown;
      pickup?: unknown;
      dropoff?: unknown;
      pickupNote?: unknown;
      type?: unknown;
      paymentMethod?: unknown;
    };

    // Each end is a pin/place (current apps) or a zone id (older builds).
    const pickup = parseRideEndInput(body.pickup, "pickup");
    const dropoff = parseRideEndInput(body.dropoff, "dropoff");
    for (const parsed of [pickup, dropoff]) {
      if (parsed && "error" in parsed) return reply.code(400).send({ error: parsed.error });
    }
    const note = parsePickupNote(body.pickupNote);
    if (!note.ok) return reply.code(400).send({ error: note.error, code: "NOTE_TOO_LONG" });

    if (
      (!pickup && !isNonEmptyString(body.pickupZoneId)) ||
      (!dropoff && !isNonEmptyString(body.dropoffZoneId)) ||
      !isRideType(body.type)
    ) {
      return reply.code(400).send({
        error: "pickup (or pickupZoneId), dropoff (or dropoffZoneId), and type (LONE|SHARED) are required",
      });
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
        // A zone id sent alongside a pin is ignored: the server derives it.
        ...(pickup ? { pickup: pickup as RideEndInput } : { pickupZoneId: body.pickupZoneId as string }),
        ...(dropoff ? { dropoff: dropoff as RideEndInput } : { dropoffZoneId: body.dropoffZoneId as string }),
        pickupNote: note.note,
        paymentMethod,
      });
    } catch (err) {
      if (err instanceof LaunchNotOpenError) {
        return reply
          .code(422)
          .send({ error: err.message, code: err.code, launchAt: err.launchAt.toISOString() });
      }
      if (err instanceof SameZoneError) {
        return reply.code(400).send({ error: err.message });
      }
      if (err instanceof TripTooShortError) {
        return reply.code(400).send({ error: err.message, code: err.code });
      }
      if (err instanceof OutsideServiceAreaError) {
        return reply.code(422).send({ error: err.message, code: err.code, end: err.end });
      }
      if (err instanceof PlaceNotFoundError) {
        return reply.code(404).send({ error: err.message, code: err.code, end: err.end });
      }
      if (err instanceof ZoneRetiredError) {
        return reply.code(400).send({ error: err.message, code: err.code });
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

  app.get("/rides/mine", { onRequest: requireAuth, schema: SCHEMAS.mine }, async (request, reply) => {
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

    // Only rides this rider booked, but a ride they joined as someone
    // else's passenger never appears here; their own pins are theirs to see
    // (Recent destinations are built from them).
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
  app.get("/rides/active", { onRequest: requireAuth, schema: SCHEMAS.active }, async (request, reply) => {
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
        // This rider's own pins (their seat's; the ride's for an old-style
        // ride with no seat). All null for a ride booked without pins.
        ...pinFieldsOf(passenger ?? (ride.riderId === request.user!.userId ? ride : null)),
        // First name only: all the banner needs ("Kofi is 3 min away").
        driver: driverUser ? { firstName: driverUser.name.trim().split(/\s+/)[0] ?? "" } : null,
      },
    });
  });

  app.get("/rides/:id", { onRequest: requireAuth, schema: SCHEMAS.detail }, async (request, reply) => {
    if (!(await requireRider(request, reply))) return;

    const { id } = request.params as { id: string };

    const ride = await prisma.ride.findUnique({
      where: { id },
      select: riderRideDetailSelect,
    });

    const userId = request.user!.userId;
    if (!ride || (ride.riderId !== userId && !ride.passengers.some((p) => p.riderId === userId))) {
      return rideNotFound(reply);
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

    return reply
      .code(200)
      .send({ ride: hideOtherRidersPins(ride, userId), driver, ...(fareSummary ? { fareSummary } : {}) });
  });

  app.post("/rides/:id/decision", { onRequest: requireAuth, schema: SCHEMAS.decision }, async (request, reply) => {
    if (!(await requireRider(request, reply))) return;

    const { id } = request.params as { id: string };
    const body = request.body as { action?: unknown };

    if (!isDecisionAction(body.action)) {
      return reply
        .code(400)
        .send({ error: "action must be one of KEEP_WAITING | SWITCH_TO_LONE | CANCEL" });
    }

    const ride = await prisma.ride.findUnique({ where: { id } });
    if (!ride || ride.riderId !== request.user!.userId) {
      return rideNotFound(reply);
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
   *
   * A shared car the driver has already added other riders to is theirs as
   * much as this rider's. Cancelling then takes only THIS rider out (their
   * seat is cancelled, exactly as a driver's seat cancel would) and the car
   * carries on for the others; it used to cancel the whole ride, stranding
   * riders who had nothing to do with the decision.
   */
  app.post(
    "/rides/:id/cancel",
    {
      onRequest: requireAuth,
      preValidation: bodyOptional,
      schema: SCHEMAS.cancel,
      config: { limits: { user: [RULES.rideCancel] } },
    },
    async (request, reply) => {
    if (!(await requireRider(request, reply))) return;

    const { id } = request.params as { id: string };
    const userId = request.user!.userId;

    const ride = await prisma.ride.findUnique({
      where: { id },
      include: { passengers: { select: { id: true, riderId: true, status: true } } },
    });
    if (!ride || ride.riderId !== userId) {
      return rideNotFound(reply);
    }
    if (!RIDER_CANCELLABLE_STATUSES.includes(ride.status as RideStatus)) {
      return reply.code(409).send({ error: "Ride can no longer be cancelled" });
    }

    const input = parseRiderCancelInput(request.body, { hasDriver: ride.driverId !== null });
    if (!input.ok) {
      return reply.code(400).send({ error: input.error });
    }

    const flagged = input.reason !== null && FLAGGED_RIDER_CANCEL_REASONS.includes(input.reason);
    const logCancel = (event: string, message: string) =>
      request.log[flagged ? "warn" : "info"](
        {
          event,
          rideId: id,
          driverId: ride.driverId,
          fromStatus: ride.status,
          riderCancelReason: input.reason,
          flagged,
        },
        flagged ? "Rider cancelled: driver asked them to cancel" : message,
      );

    const ownSeat = ride.passengers.find((p) => p.riderId === userId);
    const othersAboard = ride.passengers.some(
      (p) => p.riderId !== userId && isActivePassengerStatus(p.status as PassengerStatus),
    );

    if (ownSeat && othersAboard) {
      let result;
      try {
        result = await applyPassengerTransition(prisma, ownSeat.id, "CANCELLED", new Date(), {
          expectedRideId: id,
          onlyFrom: ["WAITING", "ARRIVED"],
        });
      } catch (err) {
        if (err instanceof InvalidTransitionError) {
          return reply.code(409).send({ error: "Ride can no longer be cancelled" });
        }
        throw err;
      }
      // Kept on the ride as for a whole-ride cancel: it is this rider's
      // booking, and "the driver asked me to cancel" must reach the admin
      // list whether or not the car carried on.
      await prisma.ride.update({
        where: { id },
        data: { riderCancelReason: input.reason, riderCancelNote: input.note },
      });

      const { passengers: _otherRiders, ...rideRow } = result.ride;
      reply.code(200).send({ ride: rideRow });

      if (result.changed) {
        emitToRider(userId, "ride:passenger_status", {
          rideId: id,
          ridePassengerId: ownSeat.id,
          riderId: userId,
          status: "CANCELLED",
        });
        // The driver's trip screen refetches on any status event for its ride.
        emitRideEvent(id, "ride:status", { rideId: id, status: rideRow.status as RideStatus });
        notifyRiderCancelled(prisma, ride);
        removeRiderFromRide(userId, id);
        logCancel("ride_seat_cancelled_by_rider", "Rider left a shared car; it carries on for the others");
      }
      return reply;
    }

    try {
      const updated = await applyRideTransition(prisma, id, "CANCELLED", {
        cancelReason: "RIDER_CANCELLED",
        riderCancel: { reason: input.reason, note: input.note },
      });
      emitRideEvent(id, "ride:status", { rideId: id, status: updated.status });
      // A driver who had already accepted it hears at once, even with the app closed.
      notifyRiderCancelled(prisma, ride);
      // Drivers who were being offered it drop it at once.
      if (ride.status === "REQUESTED" || ride.status === "AWAITING_RIDER_DECISION") {
        closeOffer(prisma, ride, "CANCELLED");
      }

      logCancel("ride_cancelled_by_rider", "Rider cancelled their ride");
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
    { onRequest: requireAuth, schema: SCHEMAS.switch, config: { limits: { user: [RULES.rideSwitch] } } },
    async (request, reply) => {
      if (!(await requireRider(request, reply))) return;

      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { type?: unknown };
      if (body.type !== "LONE" && body.type !== "SHARED") {
        return reply.code(400).send({ error: "type must be LONE or SHARED" });
      }
      const toType: RideType = body.type;

      const ride = await prisma.ride.findUnique({ where: { id } });
      if (!ride || ride.riderId !== request.user!.userId) {
        return rideNotFound(reply);
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
      onRequest: requireAuth,
      schema: SCHEMAS.initiatePayment,
      config: { limits: { user: [RULES.paymentInit] } },
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
    const passenger = ride?.passengers.find((p) => p.riderId === userId);
    if (!ride || (ride.riderId !== userId && !passenger)) return rideNotFound(reply);
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
  app.get("/rides/:id/payment-status", { onRequest: requireAuth, schema: SCHEMAS.paymentStatus }, async (request, reply) => {
    if (!(await requireRider(request, reply))) return;

    const { id: rideId } = request.params as { id: string };
    const userId = request.user!.userId;

    const ride = await prisma.ride.findUnique({
      where: { id: rideId },
      include: { passengers: true },
    });
    if (!ride || (ride.riderId !== userId && !ride.passengers.some((p) => p.riderId === userId))) {
      return rideNotFound(reply);
    }

    const summary = await getRidePaymentSummary(prisma, rideId);
    const yours = summary.perPassenger.find((p) => p.riderId === userId);

    return reply.code(200).send({
      paymentStatus: yours?.status ?? "PENDING",
      paymentMethod: ride.paymentMethod as PaymentMethod,
    });
  });
}

import type { PrismaClient } from "@prisma/client";
import type { PaymentMethod, RideSource, RideStatus, RideType } from "@rida/shared";
import { MIN_TRIP_METERS, getLoneFare, getSharedFarePerRider, haversineDistanceMeters } from "@rida/shared";
import { resolveRideEnd, type ResolvedRideEnd, type RideEndInput } from "../places/rideEnds";
import { broadcastRide } from "./dispatch";
import { findActiveRideForRider } from "./activeRide";
import { logger } from "../../lib/logger";

/** Rides in any of these statuses count as "active" — a rider may have at most one at a time. */
export { ACTIVE_RIDE_STATUSES } from "./activeRide";

/** Thrown by createRide when pickupZoneId and dropoffZoneId are the same. */
export class SameZoneError extends Error {
  constructor() {
    super("pickupZoneId and dropoffZoneId must differ");
    this.name = "SameZoneError";
  }
}

/** Thrown by createRide when the pickup and drop-off pins are practically the same spot. */
export class TripTooShortError extends Error {
  readonly code = "TRIP_TOO_SHORT";
  constructor() {
    super("Your pickup and drop-off are the same place. Choose a different drop-off.");
    this.name = "TripTooShortError";
  }
}

/** Thrown by createRide when pickupZoneId or dropoffZoneId doesn't resolve to a Zone. */
export class ZoneNotFoundError extends Error {
  constructor() {
    super("pickupZoneId or dropoffZoneId not found");
    this.name = "ZoneNotFoundError";
  }
}

/**
 * Thrown by createRide when an app sends the id of a zone that has been
 * taken out of service (an old build with an old zone list). A subclass of
 * ZoneNotFoundError so callers that only know that one still refuse it.
 */
export class ZoneRetiredError extends ZoneNotFoundError {
  readonly code = "ZONE_NOT_SERVED";
  constructor() {
    super();
    this.message = "That place isn't served any more. Please choose another pickup or drop-off.";
    this.name = "ZoneRetiredError";
  }
}

/** Thrown by createRide when the rider already has an active ride. */
export class ActiveRideExistsError extends Error {
  readonly existingRide: { id: string; status: RideStatus };

  constructor(existingRide: { id: string; status: RideStatus }) {
    super("Rider already has an active ride");
    this.name = "ActiveRideExistsError";
    this.existingRide = existingRide;
  }
}

export interface CreateRideInput {
  riderId: string;
  type: RideType;
  /**
   * Each end is EITHER a pin/place (`pickup` / `dropoff`, from current app
   * builds) OR a zone id (older builds and USSD). A pin wins: the zone is
   * then derived from it and any zone id sent alongside is ignored.
   */
  pickupZoneId?: string;
  dropoffZoneId?: string;
  pickup?: RideEndInput;
  dropoff?: RideEndInput;
  /** Already trimmed and length-checked (parsePickupNote). */
  pickupNote?: string | null;
  /** Defaults to 1 — the occupancy at creation time (a fresh ride always starts with its requester as the sole passenger). */
  occupancy?: number;
  /** Defaults to "MOMO", matching the pre-extraction route default. */
  paymentMethod?: PaymentMethod;
  /** Defaults to "APP". USSD-originated rides pass "USSD" so transition hooks know to SMS instead of push. */
  source?: RideSource;
}

/**
 * Creates a REQUESTED ride for the dispatch/matching engine to pick up, then
 * fires the existing socket broadcast to eligible drivers. Single entry
 * point for both the app's POST /rides route and the USSD callback handler —
 * both must end up with an identical DB row and an identical broadcast.
 *
 * Validation and side effects (zone existence, same-zone rejection, one-
 * active-ride-per-rider, locked fare, broadcastRide) are unchanged from the
 * pre-extraction inline version in routes/rides.ts — callers map the thrown
 * errors back to their own response shape.
 *
 * Exact pins (2026-10): an end given as a pin or place is resolved by
 * resolveRideEnd (service area, label, nearest zone) and stored on both the
 * ride and the first seat. With two pins, same-zone is allowed and only a
 * trip shorter than MIN_TRIP_METERS is refused (TripTooShortError).
 */
export async function createRide(prisma: PrismaClient, input: CreateRideInput) {
  const { riderId, type } = input;
  const occupancy = input.occupancy ?? 1;
  const paymentMethod: PaymentMethod = input.paymentMethod ?? "MOMO";
  const source: RideSource = input.source ?? "APP";

  // Pins first: they can be refused (outside the area, unknown place) before
  // anything else is read.
  const [pickupPin, dropoffPin] = await Promise.all([
    input.pickup ? resolveRideEnd(prisma, "pickup", input.pickup) : Promise.resolve(null),
    input.dropoff ? resolveRideEnd(prisma, "dropoff", input.dropoff) : Promise.resolve(null),
  ]);
  const pickupZoneId = pickupPin?.zoneId ?? input.pickupZoneId;
  const dropoffZoneId = dropoffPin?.zoneId ?? input.dropoffZoneId;
  if (!pickupZoneId || !dropoffZoneId) throw new ZoneNotFoundError();

  if (pickupPin && dropoffPin) {
    // Two pins may share a zone (zones are big); only the same SPOT is refused.
    if (haversineDistanceMeters(pickupPin, dropoffPin) < MIN_TRIP_METERS) throw new TripTooShortError();
  } else if (pickupZoneId === dropoffZoneId) {
    throw new SameZoneError();
  }

  // One-active-ride rule, through the same lookup as GET /rides/active: it
  // also sees a rider who is a passenger in someone else's car (merged), who
  // a riderId-only check let book a second ride mid-trip.
  const [pickupZone, dropoffZone, existingActive, rider] = await Promise.all([
    prisma.zone.findUnique({ where: { id: pickupZoneId } }),
    prisma.zone.findUnique({ where: { id: dropoffZoneId } }),
    findActiveRideForRider(prisma, riderId),
    // A review demo rider's rides are demo rides (services/reviewDemo).
    prisma.user.findUnique({ where: { id: riderId }, select: { isReviewDemo: true } }),
  ]);
  const existingActiveRide = existingActive?.ride ?? null;

  if (!pickupZone || !dropoffZone) {
    throw new ZoneNotFoundError();
  }
  if (pickupZone.retiredAt || dropoffZone.retiredAt) {
    throw new ZoneRetiredError();
  }
  if (existingActiveRide) {
    throw new ActiveRideExistsError(existingActiveRide);
  }

  const pins = pinColumns(pickupPin, dropoffPin, input.pickupNote ?? null);

  const lockedFare = type === "SHARED" ? getSharedFarePerRider(1) : getLoneFare();

  const ride = await prisma.ride.create({
    data: {
      riderId,
      type,
      status: "REQUESTED",
      source,
      pickupZoneId,
      dropoffZoneId,
      occupancy,
      paymentMethod,
      broadcastStartedAt: new Date(),
      isReviewDemo: rider?.isReviewDemo ?? false,
      ...pins,
      passengers: {
        create: {
          riderId,
          pickupZoneId,
          dropoffZoneId,
          status: "WAITING",
          lockedFare,
          ...pins,
        },
      },
    },
    include: { passengers: true },
  });

  // Notify eligible real drivers via socket. Fire-and-forget — identical to
  // the pre-extraction call site in routes/rides.ts.
  broadcastRide(prisma, ride.id).catch((err) => {
    logger.error("broadcastRide failed", { rideId: ride.id, err });
  });

  return ride;
}

/** The pin columns for a new ride and its first seat (all null for a zone-only booking). */
function pinColumns(pickup: ResolvedRideEnd | null, dropoff: ResolvedRideEnd | null, pickupNote: string | null) {
  return {
    pickupLat: pickup?.latitude ?? null,
    pickupLng: pickup?.longitude ?? null,
    pickupLabel: pickup?.label ?? null,
    pickupPlaceId: pickup?.placeId ?? null,
    dropoffLat: dropoff?.latitude ?? null,
    dropoffLng: dropoff?.longitude ?? null,
    dropoffLabel: dropoff?.label ?? null,
    dropoffPlaceId: dropoff?.placeId ?? null,
    pickupNote,
  };
}

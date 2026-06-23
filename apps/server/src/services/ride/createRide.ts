import type { PrismaClient } from "@prisma/client";
import type { PaymentMethod, RideSource, RideStatus, RideType } from "@rida/shared";
import { getLoneFare, getSharedFarePerRider } from "@rida/shared";
import { broadcastRide } from "./dispatch";

/** Rides in any of these statuses count as "active" — a rider may have at most one at a time. */
export const ACTIVE_RIDE_STATUSES: RideStatus[] = [
  "REQUESTED",
  "MATCHED",
  "ARRIVED",
  "IN_PROGRESS",
  "AWAITING_RIDER_DECISION",
];

/** Thrown by createRide when pickupZoneId and dropoffZoneId are the same. */
export class SameZoneError extends Error {
  constructor() {
    super("pickupZoneId and dropoffZoneId must differ");
    this.name = "SameZoneError";
  }
}

/** Thrown by createRide when pickupZoneId or dropoffZoneId doesn't resolve to a Zone. */
export class ZoneNotFoundError extends Error {
  constructor() {
    super("pickupZoneId or dropoffZoneId not found");
    this.name = "ZoneNotFoundError";
  }
}

/** Thrown by createRide when the rider already has an active ride. */
export class ActiveRideExistsError extends Error {
  readonly existingRide: { id: string };

  constructor(existingRide: { id: string }) {
    super("Rider already has an active ride");
    this.name = "ActiveRideExistsError";
    this.existingRide = existingRide;
  }
}

export interface CreateRideInput {
  riderId: string;
  type: RideType;
  pickupZoneId: string;
  dropoffZoneId: string;
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
 */
export async function createRide(prisma: PrismaClient, input: CreateRideInput) {
  const { riderId, type, pickupZoneId, dropoffZoneId } = input;
  const occupancy = input.occupancy ?? 1;
  const paymentMethod: PaymentMethod = input.paymentMethod ?? "MOMO";
  const source: RideSource = input.source ?? "APP";

  if (pickupZoneId === dropoffZoneId) {
    throw new SameZoneError();
  }

  const [pickupZone, dropoffZone, existingActiveRide] = await Promise.all([
    prisma.zone.findUnique({ where: { id: pickupZoneId } }),
    prisma.zone.findUnique({ where: { id: dropoffZoneId } }),
    prisma.ride.findFirst({ where: { riderId, status: { in: ACTIVE_RIDE_STATUSES } } }),
  ]);

  if (!pickupZone || !dropoffZone) {
    throw new ZoneNotFoundError();
  }
  if (existingActiveRide) {
    throw new ActiveRideExistsError(existingActiveRide);
  }

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
      passengers: {
        create: {
          riderId,
          pickupZoneId,
          dropoffZoneId,
          status: "WAITING",
          lockedFare,
        },
      },
    },
    include: { passengers: true },
  });

  // Notify eligible real drivers via socket. Fire-and-forget — identical to
  // the pre-extraction call site in routes/rides.ts.
  broadcastRide(prisma, ride.id).catch((err) => {
    console.error(`[broadcastRide] failed for ride ${ride.id}:`, err);
  });

  return ride;
}

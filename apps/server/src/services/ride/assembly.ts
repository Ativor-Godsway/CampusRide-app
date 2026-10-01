import type { PrismaClient, Prisma } from "@prisma/client";
import { PRICING } from "@rida/shared";
import {
  NoSeatsAvailableError,
  NotRideOwnerError,
  RequestRideUnavailableError,
  RideNotFillableError,
  RideNotReadyToDepartError,
} from "./errors";
import type { Ride, RidePassenger } from "@prisma/client";
import { applyRideTransition, joinLoadedSharedRideTx } from "./rideService";
import { isActivePassengerStatus } from "./stateMachine";

/**
 * `maxWait` (time allowed to acquire a pooled connection before the
 * transaction can even start) defaults to 2s, which is too tight when two
 * concurrent addRiderToCar calls compete for connections against Neon's
 * pool — raise it so both can queue and start; the atomic conditional
 * updateMany inside still arbitrates the actual race.
 */
const TX_OPTIONS = { timeout: 20000, maxWait: 10000 } as const;

export type RideWithPassengers = Prisma.RideGetPayload<{ include: { passengers: true } }>;

/** Car statuses a rider may be added in. IN_PROGRESS since 2026-10-02 (sketch 6). */
export const FILLABLE_STATUSES = ["MATCHED", "ARRIVED", "IN_PROGRESS"] as const;

/** A request about to be added, as the detour check sees it. */
export interface AddCandidate {
  riderId: string;
  pickupZoneId: string;
  dropoffZoneId: string;
}

export interface AddRiderOptions {
  /**
   * Called inside the transaction, with the car locked, before anything is
   * kept. Throw (e.g. DetourTooLongError) to refuse: the whole transaction
   * rolls back, including the absorbed request.
   */
  checkCar?: (car: { anchor: Ride; passengers: readonly RidePassenger[]; candidate: AddCandidate }) => void;
}

/**
 * "Fill the car": a driver pulls a still-pending SHARED request into their
 * claimed car — before departure (MATCHED/ARRIVED) and, since 2026-10-02,
 * also while driving (IN_PROGRESS).
 *
 * Merge representation: the absorbed `requestRide` is closed (CANCELLED,
 * cancelReason MERGED_INTO_ANOTHER_RIDE, mergedIntoRideId = anchorRideId);
 * its rider joins the anchor ride as a WAITING RidePassenger. The anchor's
 * passenger list stays the single source of truth for "who is in this car
 * and what they pay"; mergedIntoRideId is the audit trail.
 *
 * One transaction, no torn state:
 * 1. Lock the anchor ride (FOR UPDATE) and read its passengers.
 * 2. Absorb the request with one conditional UPDATE that only one caller
 *    can win (status REQUESTED, unclaimed, SHARED) — the atomic-claim pattern.
 * 3. Check the car can take them: owned by this driver, in a fillable
 *    status, a free seat counted from riders actually in the car, and the
 *    caller's checkCar (the detour limit for a moving car). Any refusal
 *    throws and rolls the absorb back.
 * 4. Add the rider. Before departure the usual downward-only fare ratchet
 *    runs; once IN_PROGRESS, fares are frozen (departure is still exactly
 *    where that happens), so existing riders' locked fares are not touched
 *    at all and the new rider gets the flat shared fare.
 *
 * The ride's own status never changes here: a car that is IN_PROGRESS stays
 * IN_PROGRESS (departedAt untouched) and the new rider goes WAITING →
 * ARRIVED → PICKED_UP → DROPPED_OFF through the per-passenger actions.
 *
 * Throws (nothing kept):
 * - NotRideOwnerError: someone else's car
 * - RideNotFillableError: car not MATCHED/ARRIVED/IN_PROGRESS
 * - NoSeatsAvailableError: 4 riders already in the car
 * - RequestRideUnavailableError: request no longer open
 * - whatever checkCar throws
 *
 * Idempotent: adding a rider already merged into this car returns it with
 * `changed: false`.
 */
export async function addRiderToCar(
  prisma: PrismaClient,
  driverId: string,
  anchorRideId: string,
  requestRideId: string,
  options: AddRiderOptions = {},
): Promise<RideWithPassengers & { changed: boolean }> {
  return prisma.$transaction(async (tx) => {
    // Lock the car first: two quick "Add" taps (or two drivers' worth of
    // retries) could otherwise both see a free seat.
    const [anchor] = await tx.$queryRaw<Ride[]>`SELECT * FROM "Ride" WHERE id = ${anchorRideId} FOR UPDATE`;
    if (!anchor) throw new RideNotFillableError(anchorRideId, "MISSING");
    if (anchor.driverId !== driverId) {
      throw new NotRideOwnerError(anchorRideId, driverId);
    }
    const passengers = await tx.ridePassenger.findMany({
      where: { rideId: anchorRideId },
      orderBy: { createdAt: "asc" },
    });
    const fillable = (FILLABLE_STATUSES as readonly string[]).includes(anchor.status);
    const seated = passengers.filter((p) => isActivePassengerStatus(p.status)).length;

    const [request] = fillable && seated < PRICING.MAX_SHARED_OCCUPANCY
      ? await tx.$queryRaw<Ride[]>`
          UPDATE "Ride"
          SET status = 'CANCELLED', "cancelReason" = 'MERGED_INTO_ANOTHER_RIDE', "mergedIntoRideId" = ${anchorRideId}
          WHERE id = ${requestRideId} AND status = 'REQUESTED' AND "driverId" IS NULL AND type = 'SHARED'
          RETURNING *`
      : [];

    if (!request) {
      // A retry of an add that already landed is a success, not an error.
      const existing = await tx.ride.findUnique({
        where: { id: requestRideId },
        select: { mergedIntoRideId: true },
      });
      if (existing?.mergedIntoRideId === anchorRideId) {
        return { ...anchor, passengers, changed: false };
      }
      if (!fillable) throw new RideNotFillableError(anchorRideId, anchor.status);
      if (seated >= PRICING.MAX_SHARED_OCCUPANCY) throw new NoSeatsAvailableError(anchorRideId);
      throw new RequestRideUnavailableError(requestRideId);
    }

    const candidate = {
      riderId: request.riderId,
      pickupZoneId: request.pickupZoneId,
      dropoffZoneId: request.dropoffZoneId,
    };
    options.checkCar?.({ anchor, passengers, candidate });

    const joined = await joinLoadedSharedRideTx(tx, anchor, passengers, candidate, {
      freezeExistingFares: anchor.status === "IN_PROGRESS",
    });

    return { ...joined.ride, passengers: joined.passengers, changed: true };
  }, TX_OPTIONS);
}

/**
 * Departure finalization (Phase 2d): ARRIVED -> IN_PROGRESS.
 *
 * Verifies `driverId` owns the ride and it's ARRIVED, then delegates to
 * `applyRideTransition`, which stamps `departedAt` and validates the
 * transition via the state machine. From this point lockedFares are frozen
 * permanently — `addRiderToCar` rejects any ride that isn't MATCHED/ARRIVED,
 * so no recompute can run on an IN_PROGRESS ride.
 *
 */
export async function departRide(
  prisma: PrismaClient,
  driverId: string,
  rideId: string,
  now: Date = new Date(),
) {
  const ride = await prisma.ride.findUniqueOrThrow({ where: { id: rideId } });

  if (ride.driverId !== driverId) {
    throw new NotRideOwnerError(rideId, driverId);
  }
  if (ride.status !== "ARRIVED") {
    throw new RideNotReadyToDepartError(rideId, ride.status);
  }

  return applyRideTransition(prisma, rideId, "IN_PROGRESS", {}, now);
}

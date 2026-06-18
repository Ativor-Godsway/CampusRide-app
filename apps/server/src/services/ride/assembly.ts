import type { PrismaClient, Prisma } from "@prisma/client";
import { PRICING } from "@rida/shared";
import {
  NoSeatsAvailableError,
  NotRideOwnerError,
  RequestRideUnavailableError,
  RideNotFillableError,
  RideNotReadyToDepartError,
} from "./errors";
import { applyRideTransition } from "./rideService";
import { joinSharedRideTx } from "./rideService";

/**
 * `maxWait` (time allowed to acquire a pooled connection before the
 * transaction can even start) defaults to 2s, which is too tight when two
 * concurrent addRiderToCar calls compete for connections against Neon's
 * pool — raise it so both can queue and start; the atomic conditional
 * updateMany inside still arbitrates the actual race.
 */
const TX_OPTIONS = { timeout: 20000, maxWait: 10000 } as const;

export type RideWithPassengers = Prisma.RideGetPayload<{ include: { passengers: true } }>;

/**
 * "Fill the car" (Phase 2d): a driver pulls a still-pending SHARED request
 * into their already-claimed car.
 *
 * Merge representation: the absorbed `requestRide` is closed
 * (CANCELLED, cancelReason MERGED_INTO_ANOTHER_RIDE, mergedIntoRideId =
 * anchorRideId) — it is never an orphaned/independent REQUESTED ride again,
 * and never double-counted in fares. Its rider is added to the anchor ride
 * as a RidePassenger via `joinSharedRideTx`, which applies the same
 * downward-only locked-fare ratchet (recomputeLockedFares) used by the
 * normal join path. This keeps a single source of truth for "who is in this
 * car and what they pay" — the anchor ride's passenger list — while leaving
 * an audit trail (mergedIntoRideId) on the absorbed request.
 *
 * Steps (all inside one transaction — no torn state on failure):
 * 1. Load the anchor ride; verify `driverId` owns it and it's MATCHED or
 *    ARRIVED (claimed, not yet departed) with a free seat (occupancy < 4).
 * 2. Load the request ride; verify it's still REQUESTED, unclaimed, SHARED.
 * 3. Atomically absorb the request ride — a conditional UPDATE
 *    (`WHERE status = 'REQUESTED' AND driverId IS NULL`) that only one
 *    concurrent caller can win, mirroring claimRide's atomic-claim pattern.
 *    If it affects 0 rows, another driver already absorbed it.
 * 4. Move the request's rider onto the anchor via `joinSharedRideTx`.
 *
 * No route/zone compatibility check: a driver may combine ANY pending SHARED
 * request into their car (product decision — compatibility is surfaced to the
 * driver as a sort hint in `/rides/:id/fill-suggestions`, not enforced as a
 * guardrail here). This previously threw `RidesNotCombinableError` via
 * `areCombinable`; that check is intentionally removed.
 *
 * Throws (no DB writes on any of these):
 * - NotRideOwnerError: anchor.driverId !== driverId
 * - RideNotFillableError: anchor.status not in {MATCHED, ARRIVED}
 * - NoSeatsAvailableError: anchor.occupancy >= 4
 * - RequestRideUnavailableError: request not REQUESTED/unclaimed/SHARED
 *   (checked up front, and again via the atomic absorb for races)
 */
export async function addRiderToCar(
  prisma: PrismaClient,
  driverId: string,
  anchorRideId: string,
  requestRideId: string,
): Promise<RideWithPassengers> {
  return prisma.$transaction(async (tx) => {
    const anchor = await tx.ride.findUniqueOrThrow({
      where: { id: anchorRideId },
      include: { passengers: true },
    });

    if (anchor.driverId !== driverId) {
      throw new NotRideOwnerError(anchorRideId, driverId);
    }
    if (anchor.status !== "MATCHED" && anchor.status !== "ARRIVED") {
      throw new RideNotFillableError(anchorRideId, anchor.status);
    }
    if (anchor.occupancy >= PRICING.MAX_SHARED_OCCUPANCY) {
      throw new NoSeatsAvailableError(anchorRideId);
    }

    const request = await tx.ride.findUniqueOrThrow({ where: { id: requestRideId } });

    if (request.status !== "REQUESTED" || request.driverId !== null || request.type !== "SHARED") {
      throw new RequestRideUnavailableError(requestRideId);
    }

    const absorbed = await tx.ride.updateMany({
      where: { id: requestRideId, status: "REQUESTED", driverId: null },
      data: {
        status: "CANCELLED",
        cancelReason: "MERGED_INTO_ANOTHER_RIDE",
        mergedIntoRideId: anchorRideId,
      },
    });
    if (absorbed.count !== 1) {
      throw new RequestRideUnavailableError(requestRideId);
    }

    await joinSharedRideTx(tx, anchorRideId, {
      riderId: request.riderId,
      pickupZoneId: request.pickupZoneId,
      dropoffZoneId: request.dropoffZoneId,
    });

    return tx.ride.findUniqueOrThrow({
      where: { id: anchorRideId },
      include: { passengers: true },
    });
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

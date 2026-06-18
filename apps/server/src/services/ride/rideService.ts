import type { PrismaClient, Prisma } from "@prisma/client";
import {
  getSharedFarePerRider,
  validateSharedOccupancy,
} from "@rida/shared";
import type { PassengerStatus, RideStatus } from "@rida/shared";
import {
  isActivePassengerStatus,
  transitionPassenger,
  transitionRide,
  type RideTransitionContext,
} from "./stateMachine";
import { recomputeLockedFares, type LockedFarePassenger } from "./lockedFare";

export type Tx = Prisma.TransactionClient | PrismaClient;

/**
 * Neon's pooled connection has noticeable per-query latency, and these
 * transactions issue several sequential queries — raise the interactive
 * transaction timeout above Prisma's 5s default to avoid spurious P2028s.
 */
const TX_OPTIONS = { timeout: 20000 } as const;

/**
 * Validates and applies a Ride status transition inside a transaction.
 * Throws InvalidTransitionError for illegal moves (no DB writes occur).
 *
 * Side effects beyond status/cancelReason:
 * - MATCHED -> REQUESTED (driver backout): clears driverId, preserves passengers.
 * - ARRIVED -> IN_PROGRESS (departure): stamps departedAt; lockedFares freeze
 *   permanently from this point (no further recompute calls are made).
 * - IN_PROGRESS -> COMPLETED: stamps completedAt.
 * - * -> REQUESTED: stamps broadcastStartedAt = now and clears decisionStartedAt
 *   (a fresh broadcast/dispatch window starts).
 * - * -> AWAITING_RIDER_DECISION: stamps decisionStartedAt = now (the 90s
 *   grace period for the rider's decision starts).
 *
 * `now` is injectable so timeout-related transitions can be driven by tests
 * without depending on wall-clock time.
 */
export async function applyRideTransition(
  prisma: PrismaClient,
  rideId: string,
  toStatus: RideStatus,
  ctx: RideTransitionContext = {},
  now: Date = new Date(),
) {
  return prisma.$transaction((tx) => transitionRideTx(tx, rideId, toStatus, ctx, now), TX_OPTIONS);
}

/**
 * Core of `applyRideTransition`, factored out so it can be composed inside a
 * larger transaction (Phase 6b-3: `applyPassengerTransition` walks the ride
 * forward on first-pickup/last-dropoff without opening a second, nested
 * transaction — `tx` here is already an open transaction client).
 */
async function transitionRideTx(
  tx: Tx,
  rideId: string,
  toStatus: RideStatus,
  ctx: RideTransitionContext = {},
  now: Date = new Date(),
) {
  const ride = await tx.ride.findUniqueOrThrow({ where: { id: rideId } });
  const result = transitionRide(ride, toStatus, ctx);

  const data: Prisma.RideUpdateInput = {
    status: result.status,
    cancelReason: result.cancelReason,
  };

  if (ride.status === "MATCHED" && toStatus === "REQUESTED" && ride.driverId) {
    data.driver = { disconnect: true };
  }
  if (toStatus === "IN_PROGRESS") {
    data.departedAt = new Date();
  }
  if (toStatus === "COMPLETED") {
    data.completedAt = new Date();
  }
  if (toStatus === "REQUESTED") {
    data.broadcastStartedAt = now;
    data.decisionStartedAt = null;
  }
  if (toStatus === "AWAITING_RIDER_DECISION") {
    data.decisionStartedAt = now;
  }

  return tx.ride.update({ where: { id: rideId }, data });
}

export interface PassengerTransitionResult {
  passenger: Awaited<ReturnType<Tx["ridePassenger"]["update"]>>;
  /** Always re-fetched with passengers included, regardless of which side
   * effect branch fired, so callers get a consistent shape every time. */
  ride: Prisma.RideGetPayload<{ include: { passengers: true } }>;
}

/**
 * Validates and applies a RidePassenger status transition inside a transaction.
 * Side effects, all computed from a fresh read of sibling passengers taken
 * AFTER locking the parent Ride row (see below) — never from a snapshot taken
 * before the lock, which could be stale under concurrent calls:
 *
 * - WAITING/ARRIVED -> CANCELLED: recomputes the ride's occupancy from the
 *   remaining active passengers; if none remain, cancels the ride with reason
 *   ALL_PASSENGERS_LEFT (via transitionRide — throws InvalidTransitionError,
 *   rolling back the whole transaction, if the ride is already terminal).
 *   lockedFares of remaining passengers are left unchanged (downward-only ratchet).
 * - ARRIVED -> PICKED_UP (Phase 6b-3, "Option B" auto-walk): if no sibling is
 *   already PICKED_UP/DROPPED_OFF (i.e. this is the ride's first pickup), the
 *   RIDE is walked forward to IN_PROGRESS in this same transaction — through
 *   ARRIVED first if it's still MATCHED, since `RIDE_TRANSITIONS` requires
 *   that hop and this auto-walk intentionally does NOT add a direct
 *   MATCHED -> IN_PROGRESS edge to the general map (that would let any caller
 *   skip ARRIVED, not just this one). If the ride is already IN_PROGRESS
 *   (a later passenger's first pickup), nothing ride-level happens. There is
 *   no fare-lock or payment-initiation side effect here — Phase 7a decoupled
 *   payment from departure, and `addRiderToCar` already refuses new adds once
 *   the ride leaves MATCHED/ARRIVED, so fares are already frozen by then.
 * - PICKED_UP -> DROPPED_OFF: stamps `fareCharged` from the frozen
 *   `lockedFare`. If no sibling remains WAITING/ARRIVED/PICKED_UP (this was
 *   the last active passenger), the RIDE is walked forward to COMPLETED in
 *   this same transaction. Per-rider fare-summary emission and the CASH
 *   CommissionLedger upsert are NOT done here (no socket/payment imports in
 *   this module) — the caller (driver.ts route) does that after this
 *   transaction commits, using the returned `ride.status` to decide whether
 *   completion just happened.
 */
export async function applyPassengerTransition(
  prisma: PrismaClient,
  passengerId: string,
  toStatus: PassengerStatus,
  now: Date = new Date(),
): Promise<PassengerTransitionResult> {
  return prisma.$transaction(async (tx) => {
    const passenger = await tx.ridePassenger.findUniqueOrThrow({ where: { id: passengerId } });
    const result = transitionPassenger(passenger, toStatus);

    /**
     * Lock the parent Ride row before reading any sibling passenger so that
     * concurrent per-passenger actions on the SAME ride (two near-
     * simultaneous "last dropoff" taps, a cancel racing a pickup, etc.)
     * serialize against each other. Mirrors `addRiderToCar`'s atomic-claim
     * pattern but via row lock rather than a conditional `updateMany` — the
     * decision here ("is this the first pickup / last dropoff?") depends on
     * the aggregate state of every sibling row, which a conditional update on
     * a single row can't express. Without this, two transactions reading
     * siblings before either commits could each conclude they are NOT last
     * and the ride would never auto-complete.
     */
    await tx.$queryRaw`SELECT id FROM "Ride" WHERE id = ${passenger.rideId} FOR UPDATE`;

    const updatedPassenger = await tx.ridePassenger.update({
      where: { id: passengerId },
      data: {
        status: result.status,
        ...(toStatus === "DROPPED_OFF" ? { fareCharged: passenger.lockedFare } : {}),
      },
    });

    let ride = await tx.ride.findUniqueOrThrow({ where: { id: passenger.rideId } });
    const siblings = await tx.ridePassenger.findMany({
      where: { rideId: passenger.rideId, id: { not: passengerId } },
    });

    if (toStatus === "CANCELLED") {
      const remainingActive = siblings.filter((p) => isActivePassengerStatus(p.status));

      if (remainingActive.length === 0) {
        const rideResult = transitionRide(ride, "CANCELLED", {
          cancelReason: "ALL_PASSENGERS_LEFT",
        });
        ride = await tx.ride.update({
          where: { id: ride.id },
          data: {
            status: rideResult.status,
            cancelReason: rideResult.cancelReason,
            occupancy: 0,
          },
        });
      } else {
        ride = await tx.ride.update({
          where: { id: ride.id },
          data: { occupancy: remainingActive.length },
        });
      }
    }

    if (toStatus === "PICKED_UP" && ride.status !== "IN_PROGRESS") {
      const someoneAlreadyMoving = siblings.some(
        (p) => p.status === "PICKED_UP" || p.status === "DROPPED_OFF",
      );
      if (!someoneAlreadyMoving) {
        if (ride.status === "MATCHED") {
          ride = await transitionRideTx(tx, ride.id, "ARRIVED", {}, now);
        }
        ride = await transitionRideTx(tx, ride.id, "IN_PROGRESS", {}, now);
      }
    }

    if (toStatus === "DROPPED_OFF") {
      const anyoneStillActive = siblings.some((p) => isActivePassengerStatus(p.status));
      if (!anyoneStillActive) {
        ride = await transitionRideTx(tx, ride.id, "COMPLETED", {}, now);
      }
    }

    // Re-fetch once at the end with passengers included so every branch
    // (and every caller) gets the same consistent shape, regardless of which
    // side effect (if any) fired above.
    const finalRide = await tx.ride.findUniqueOrThrow({
      where: { id: ride.id },
      include: { passengers: true },
    });

    return { passenger: updatedPassenger, ride: finalRide };
  }, TX_OPTIONS);
}

export interface JoinSharedRideInput {
  riderId: string;
  pickupZoneId: string;
  dropoffZoneId: string;
}

/**
 * Adds a new passenger to a SHARED ride and re-locks fares for everyone
 * currently active, using the downward-only ratchet from recomputeLockedFares.
 * Throws if the resulting occupancy would exceed 4 (validateSharedOccupancy).
 *
 * Core logic lives in `joinSharedRideTx` so it can be composed inside a
 * larger transaction (e.g. addRiderToCar in Phase 2d); this wrapper opens
 * its own transaction for standalone callers.
 */
export async function joinSharedRide(
  prisma: PrismaClient,
  rideId: string,
  input: JoinSharedRideInput,
) {
  return prisma.$transaction((tx) => joinSharedRideTx(tx, rideId, input), TX_OPTIONS);
}

export async function joinSharedRideTx(tx: Tx, rideId: string, input: JoinSharedRideInput) {
  const ride = await tx.ride.findUniqueOrThrow({
    where: { id: rideId },
    include: { passengers: true },
  });

  if (ride.type !== "SHARED") {
    throw new Error("joinSharedRide: ride is not a SHARED ride");
  }

  const activePassengers = ride.passengers.filter((p) =>
    isActivePassengerStatus(p.status),
  );
  const newOccupancy = activePassengers.length + 1;
  validateSharedOccupancy(newOccupancy);

  const newRate = getSharedFarePerRider(newOccupancy);

  const passengersForRecompute: LockedFarePassenger[] = [
    ...activePassengers.map((p) => ({
      id: p.id,
      status: p.status,
      lockedFare: p.lockedFare ?? newRate,
    })),
    { id: "__new__", status: "WAITING" as const, lockedFare: newRate },
  ];

  const recomputed = recomputeLockedFares(passengersForRecompute, {
    type: "JOIN",
  });

  for (const p of recomputed) {
    if (p.id === "__new__") continue;
    const original = activePassengers.find((a) => a.id === p.id);
    if (original && original.lockedFare !== p.lockedFare) {
      await tx.ridePassenger.update({
        where: { id: p.id },
        data: { lockedFare: p.lockedFare },
      });
    }
  }

  const newPassengerLockedFare =
    recomputed.find((p) => p.id === "__new__")?.lockedFare ?? newRate;

  const newPassenger = await tx.ridePassenger.create({
    data: {
      rideId,
      riderId: input.riderId,
      pickupZoneId: input.pickupZoneId,
      dropoffZoneId: input.dropoffZoneId,
      status: "WAITING",
      lockedFare: newPassengerLockedFare,
    },
  });

  const updatedRide = await tx.ride.update({
    where: { id: rideId },
    data: { occupancy: newOccupancy },
  });

  return { passenger: newPassenger, ride: updatedRide };
}

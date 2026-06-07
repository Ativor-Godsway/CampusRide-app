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
  return prisma.$transaction(async (tx) => {
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
  }, TX_OPTIONS);
}

export interface PassengerTransitionResult {
  passenger: Awaited<ReturnType<Tx["ridePassenger"]["update"]>>;
  ride: Awaited<ReturnType<Tx["ride"]["findUniqueOrThrow"]>>;
}

/**
 * Validates and applies a RidePassenger status transition inside a transaction.
 *
 * On WAITING/PICKED_UP -> CANCELLED:
 * - Recomputes the ride's occupancy from the remaining active passengers.
 * - If no active passengers remain, cancels the ride with reason
 *   ALL_PASSENGERS_LEFT (via transitionRide — throws InvalidTransitionError,
 *   rolling back the whole transaction, if the ride is already terminal).
 * - lockedFares of remaining passengers are left unchanged (downward-only ratchet).
 */
export async function applyPassengerTransition(
  prisma: PrismaClient,
  passengerId: string,
  toStatus: PassengerStatus,
) {
  return prisma.$transaction(async (tx) => {
    const passenger = await tx.ridePassenger.findUniqueOrThrow({
      where: { id: passengerId },
      include: { ride: { include: { passengers: true } } },
    });

    const result = transitionPassenger(passenger, toStatus);

    const updatedPassenger = await tx.ridePassenger.update({
      where: { id: passengerId },
      data: { status: result.status },
    });

    let ride = passenger.ride;

    if (toStatus === "CANCELLED") {
      const remainingActive = passenger.ride.passengers.filter(
        (p) => p.id !== passengerId && isActivePassengerStatus(p.status),
      );

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
          include: { passengers: true },
        });
      } else {
        ride = await tx.ride.update({
          where: { id: ride.id },
          data: { occupancy: remainingActive.length },
          include: { passengers: true },
        });
      }
    }

    return { passenger: updatedPassenger, ride };
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

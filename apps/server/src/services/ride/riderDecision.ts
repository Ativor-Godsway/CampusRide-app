import type { PrismaClient } from "@prisma/client";
import { getLoneFare } from "@rida/shared";
import { applyRideTransition } from "./rideService";
import { isActivePassengerStatus, transitionRide } from "./stateMachine";
import { InvalidSwitchToLoneError } from "./errors";

const TX_OPTIONS = { timeout: 20000 } as const;

export type RiderDecisionAction = "KEEP_WAITING" | "SWITCH_TO_LONE" | "CANCEL";

/**
 * Applies a rider's decision while their ride is AWAITING_RIDER_DECISION
 * (the dispatch broadcast timed out with no driver claim):
 *
 * - KEEP_WAITING: re-broadcast — back to REQUESTED, broadcastStartedAt resets
 *   (handled by applyRideTransition's `* -> REQUESTED` side effect).
 * - SWITCH_TO_LONE: only valid with exactly one active passenger. Converts
 *   the ride to type LONE, locks that passenger's fare at the flat lone
 *   fare, and re-broadcasts (REQUESTED, broadcastStartedAt resets).
 * - CANCEL: rider gives up — CANCELLED with reason RIDER_CANCELLED.
 *
 * `now` is injectable so the broadcastStartedAt reset can be driven by
 * tests with controlled time.
 */
export async function riderDecision(
  prisma: PrismaClient,
  rideId: string,
  action: RiderDecisionAction,
  now: Date = new Date(),
) {
  switch (action) {
    case "KEEP_WAITING":
      return applyRideTransition(prisma, rideId, "REQUESTED", {}, now);

    case "CANCEL":
      return applyRideTransition(
        prisma,
        rideId,
        "CANCELLED",
        { cancelReason: "RIDER_CANCELLED" },
        now,
      );

    case "SWITCH_TO_LONE":
      return switchToLone(prisma, rideId, now);
  }
}

async function switchToLone(prisma: PrismaClient, rideId: string, now: Date) {
  return prisma.$transaction(async (tx) => {
    const ride = await tx.ride.findUniqueOrThrow({
      where: { id: rideId },
      include: { passengers: true },
    });

    const activePassengers = ride.passengers.filter((p) =>
      isActivePassengerStatus(p.status),
    );

    if (activePassengers.length !== 1) {
      throw new InvalidSwitchToLoneError(activePassengers.length);
    }

    const transition = transitionRide(ride, "REQUESTED", {});

    await tx.ridePassenger.update({
      where: { id: activePassengers[0]!.id },
      data: { lockedFare: getLoneFare() },
    });

    return tx.ride.update({
      where: { id: rideId },
      data: {
        type: "LONE",
        status: transition.status,
        cancelReason: transition.cancelReason,
        broadcastStartedAt: now,
        decisionStartedAt: null,
      },
      include: { passengers: true },
    });
  }, TX_OPTIONS);
}

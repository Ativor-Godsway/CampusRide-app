import type { PrismaClient } from "@prisma/client";
import type { RiderDecisionAction } from "@rida/shared";
import { applyRideTransition } from "./rideService";
import { switchRideType } from "./switchRideType";

export type { RiderDecisionAction };

/**
 * Applies a rider's decision while their ride is AWAITING_RIDER_DECISION
 * (the dispatch broadcast timed out with no driver claim):
 *
 * - KEEP_WAITING: re-broadcast — back to REQUESTED, broadcastStartedAt resets
 *   (handled by applyRideTransition's `* -> REQUESTED` side effect).
 * - SWITCH_TO_LONE: only valid with exactly one active passenger. Converts
 *   the ride to type LONE, locks that passenger's fare at the flat lone
 *   fare, and re-broadcasts (REQUESTED, broadcastStartedAt resets, driver
 *   rejections cleared). Same code as POST /rides/:id/switch — see
 *   switchRideType.
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
      return switchRideType(prisma, rideId, "LONE", now);
  }
}

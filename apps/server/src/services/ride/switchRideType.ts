import type { PrismaClient } from "@prisma/client";
import { getLoneFare, getSharedFarePerRider, type RideType } from "@rida/shared";
import { isActivePassengerStatus } from "./stateMachine";
import { InvalidSwitchToLoneError, RideSwitchNotAllowedError } from "./errors";

const TX_OPTIONS = { timeout: 20000 } as const;

/** Statuses in which no driver holds the ride yet, so its type may change. */
export const SWITCHABLE_STATUSES = ["REQUESTED", "AWAITING_RIDER_DECISION"] as const;

/** The fare a single rider is locked at for each ride type. */
export function fareForType(type: RideType): number {
  return type === "LONE" ? getLoneFare() : getSharedFarePerRider(1);
}

/**
 * Switches a still-searching ride between SHARED and LONE, in place.
 *
 * The SAME ride row changes type — nothing is cancelled and nothing new is
 * created — so a switch can never leave the rider with two active rides or
 * with none. It then re-broadcasts: back to REQUESTED with a fresh
 * broadcastStartedAt, and previous driver declines discarded (they declined
 * the other offer).
 *
 * Race with a driver claiming the ride: the first statement is a
 * conditional update that only matches while the ride is still unclaimed
 * (driverId null, status REQUESTED/AWAITING_RIDER_DECISION) and still the
 * other type. claimRide is the same kind of conditional update, so Postgres
 * row locking lets exactly one of them win; the loser matches zero rows. A
 * switch that loses throws RideSwitchNotAllowedError and changes nothing, and
 * the rider simply has their (now matched) ride.
 *
 * Requires exactly one active passenger — a searching ride only ever has
 * its requester, but a ride that bounced back to REQUESTED after a driver
 * backed out can hold a whole car (InvalidSwitchToLoneError; rolled back).
 */
export async function switchRideType(
  prisma: PrismaClient,
  rideId: string,
  toType: RideType,
  now: Date = new Date(),
) {
  const fromType: RideType = toType === "LONE" ? "SHARED" : "LONE";

  return prisma.$transaction(async (tx) => {
    const moved = await tx.ride.updateMany({
      where: {
        id: rideId,
        type: fromType,
        driverId: null,
        status: { in: [...SWITCHABLE_STATUSES] },
      },
      data: {
        type: toType,
        status: "REQUESTED",
        cancelReason: null,
        broadcastStartedAt: now,
        decisionStartedAt: null,
      },
    });
    if (moved.count !== 1) {
      throw new RideSwitchNotAllowedError(
        `Ride can no longer be switched to ${toType} (already matched, finished, or already ${toType})`,
      );
    }

    const passengers = await tx.ridePassenger.findMany({ where: { rideId } });
    const active = passengers.filter((p) => isActivePassengerStatus(p.status));
    if (active.length !== 1) {
      throw new InvalidSwitchToLoneError(active.length);
    }

    await tx.ridePassenger.update({
      where: { id: active[0]!.id },
      data: { lockedFare: fareForType(toType) },
    });

    // A fresh offer of a different kind: drivers who declined the old one
    // get to see this one.
    await tx.rideRejection.deleteMany({ where: { rideId } });

    return tx.ride.findUniqueOrThrow({ where: { id: rideId }, include: { passengers: true } });
  }, TX_OPTIONS);
}

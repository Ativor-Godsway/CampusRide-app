import type { PrismaClient, Ride, RidePassenger } from "@prisma/client";
import type { PassengerStatus, RideStatus } from "@rida/shared";

/** A ride in any of these statuses is still going on. */
export const ACTIVE_RIDE_STATUSES: RideStatus[] = [
  "REQUESTED",
  "MATCHED",
  "ARRIVED",
  "IN_PROGRESS",
  "AWAITING_RIDER_DECISION",
];

/** A rider whose own passenger row has one of these is still in the car (or waiting for it). */
const ACTIVE_PASSENGER_STATUSES: PassengerStatus[] = ["WAITING", "ARRIVED", "PICKED_UP"];

export interface RiderActiveRide {
  ride: Ride;
  /** This rider's own seat on the ride, when they have one. */
  passenger: RidePassenger | null;
}

/**
 * THE answer to "does this rider have a ride going on, and which?" — used
 * by GET /rides/active (so the app can always get back to it) and by
 * createRide's one-active-ride rule (so the two can never disagree).
 *
 * Two ways a rider can be in an active ride:
 *
 * 1. As a PASSENGER on it. This is the only way to find a rider who was
 *    merged into another driver's car ("fill the car"): their own request
 *    ride is closed (CANCELLED / MERGED_INTO_ANOTHER_RIDE) and they ride as
 *    a RidePassenger on the anchor ride, whose riderId is someone else. A
 *    riderId-only lookup misses them entirely.
 * 2. As the ride's REQUESTER (ride.riderId), unless their own seat on it was
 *    cancelled (e.g. the driver cancelled their pickup while the car carries
 *    on). A requester already dropped off still counts until the whole ride
 *    completes: they come back to it for the fare summary and rating.
 *
 * A passenger seat wins over a requested ride (it is where they physically
 * are). Newest first in both cases.
 */
export async function findActiveRideForRider(
  prisma: PrismaClient,
  riderId: string,
): Promise<RiderActiveRide | null> {
  const seat = await prisma.ridePassenger.findFirst({
    where: {
      riderId,
      status: { in: ACTIVE_PASSENGER_STATUSES },
      ride: { status: { in: ACTIVE_RIDE_STATUSES } },
    },
    include: { ride: true },
    orderBy: { createdAt: "desc" },
  });
  if (seat) {
    const { ride, ...passenger } = seat;
    return { ride, passenger };
  }

  const requested = await prisma.ride.findFirst({
    where: {
      riderId,
      status: { in: ACTIVE_RIDE_STATUSES },
      NOT: { passengers: { some: { riderId, status: "CANCELLED" } } },
    },
    include: { passengers: { where: { riderId } } },
    orderBy: { createdAt: "desc" },
  });
  if (!requested) return null;
  const { passengers, ...ride } = requested;
  return { ride, passenger: passengers[0] ?? null };
}

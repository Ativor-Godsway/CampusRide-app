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
const ENDED_PASSENGER_STATUSES: PassengerStatus[] = ["DROPPED_OFF", "CANCELLED"];

/**
 * Whether this rider's own trip on a ride is complete: the whole ride
 * completed, or their seat was dropped off (on a Shared ride the car may
 * still be carrying others). The fare summary, the rating and a MoMo payment
 * open on this, never on the car's status alone.
 */
export function riderTripComplete(
  ride: { status: string; passengers: ReadonlyArray<{ riderId: string; status: string }> },
  riderId: string,
): boolean {
  return (
    ride.status === "COMPLETED" ||
    ride.passengers.some((p) => p.riderId === riderId && p.status === "DROPPED_OFF")
  );
}

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
 * 2. As the ride's REQUESTER (ride.riderId), unless their own seat on it
 *    has ended: cancelled (e.g. the driver cancelled their pickup while the
 *    car carries on) or dropped off. A Shared requester dropped off while
 *    others ride on is done — their fare summary and rating come with the
 *    drop-off (riderTripComplete) — so they can book again straight away.
 *    (This used to count them until the whole ride completed, 2026-11-05.)
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
      NOT: { passengers: { some: { riderId, status: { in: ENDED_PASSENGER_STATUSES } } } },
    },
    include: { passengers: { where: { riderId } } },
    orderBy: { createdAt: "desc" },
  });
  if (!requested) return null;
  const { passengers, ...ride } = requested;
  return { ride, passenger: passengers[0] ?? null };
}

import type { PrismaClient } from "@prisma/client";
import type { RideType } from "@rida/shared";
import { MAX_SHARED_BOOKING_SEATS } from "@rida/shared";
import { fareForNewBooking, type PricedEnd } from "./farePricing";
import { isActivePassengerStatus } from "./stateMachine";
import { InvalidSwitchToLoneError, RideSwitchNotAllowedError } from "./errors";

const TX_OPTIONS = { timeout: 20000 } as const;

/** A Ride alone booking for 4 can't become Shared (3 seats at most). Nothing changes. */
export class TooManyForSharedError extends RideSwitchNotAllowedError {
  readonly code = "TOO_MANY_FOR_SHARED";
  constructor(readonly seats: number) {
    super(`Shared takes at most ${MAX_SHARED_BOOKING_SEATS} people in one booking. Keep Ride alone for ${seats}.`);
    this.name = "TooManyForSharedError";
  }
}

/** Statuses in which no driver holds the ride yet, so its type may change. */
export const SWITCHABLE_STATUSES = ["REQUESTED", "AWAITING_RIDER_DECISION"] as const;

/** A seat's pin as a priced end (null: a zone-only booking). */
export function seatEnd(lat: number | null, lng: number | null, placeId: string | null): PricedEnd | null {
  return lat !== null && lng !== null ? { latitude: lat, longitude: lng, placeId } : null;
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
  /** The price the app showed for the new type and this booking's seats (see fareForNewBooking); absent from older apps. */
  shownFare?: number | null,
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

    // The new type's price for this trip and this booking's seats, set now.
    // Ride alone keeps the party size (people); Shared takes at most 3 seats.
    const seat = active[0]!;
    if (toType === "SHARED" && seat.seats > MAX_SHARED_BOOKING_SEATS) throw new TooManyForSharedError(seat.seats);
    const lockedFare = await fareForNewBooking(
      prisma,
      toType,
      seat.seats,
      seatEnd(seat.pickupLat, seat.pickupLng, seat.pickupPlaceId),
      seatEnd(seat.dropoffLat, seat.dropoffLng, seat.dropoffPlaceId),
      shownFare,
    );
    await tx.ridePassenger.update({ where: { id: seat.id }, data: { lockedFare } });

    // A fresh offer of a different kind: drivers who declined the old one
    // get to see this one.
    await tx.rideRejection.deleteMany({ where: { rideId } });

    return tx.ride.findUniqueOrThrow({ where: { id: rideId }, include: { passengers: true } });
  }, TX_OPTIONS);
}

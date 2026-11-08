import type { PassengerStatusPayload, RideCompletedFareSummary, RideStatusPayload } from "@rida/shared";
import type { GetRideResult } from "./api";

/**
 * How the rider's trip screen reads a ride: by THIS rider's own seat, never
 * the car's status alone. On a Shared trip the car carries several riders,
 * each with their own seat (WAITING → ARRIVED → PICKED_UP → DROPPED_OFF, or
 * CANCELLED); what happens to one rider's seat says nothing about another's.
 *
 * Found on a phone test (2026-11-05): a rider added to another driver's car
 * saw "Ride cancelled" mid-trip (their own request is closed as merged, and
 * the app took a bare CANCELLED event at its word), and a rider dropped off
 * while others rode on waited for the whole car to finish.
 */

/** A request closed because its rider was added to another car: follow `mergedIntoRideId`. */
export function isMergedRequest(ride: {
  status: string;
  cancelReason?: string | null;
  mergedIntoRideId?: string | null;
}): boolean {
  return ride.status === "CANCELLED" && ride.cancelReason === "MERGED_INTO_ANOTHER_RIDE" && !!ride.mergedIntoRideId;
}

export type RiderTripOutcome = "completed" | "cancelled" | "driverCancelled" | null;

/**
 * Whether this rider's trip is over, and how — null while it is going on.
 *
 * - their seat cancelled (by the driver, or a no-show) → "driverCancelled";
 * - their seat dropped off, the ride completed, or a fare summary in hand
 *   (the server gives one only once their trip is complete) → "completed";
 * - the ride itself cancelled, unless it was merged into a car → "cancelled".
 */
export function riderTripOutcome(
  result: Pick<GetRideResult, "ride" | "fareSummary"> | undefined,
  riderId: string | undefined,
): RiderTripOutcome {
  if (!result) return null;
  const { ride, fareSummary } = result;
  if (isMergedRequest(ride)) return null;
  const mySeat = ride.passengers.find((p) => p.riderId === riderId);
  if (mySeat?.status === "CANCELLED") return "driverCancelled";
  if (ride.status === "COMPLETED" || mySeat?.status === "DROPPED_OFF" || fareSummary) return "completed";
  if (ride.status === "CANCELLED") return "cancelled";
  return null;
}

/**
 * A `ride:status` event applied to the cached ride. A CANCELLED event is
 * taken only when it says why the ride was merged (and into which car); a
 * bare one — from older servers, or a real cancel — is left for the server
 * to confirm (the caller re-reads the ride), so the screen never shows
 * "Ride cancelled" from an event alone.
 */
export function withRideStatus(current: GetRideResult | undefined, payload: RideStatusPayload): GetRideResult | undefined {
  if (!current) return current;
  if (payload.status === "CANCELLED") {
    if (payload.cancelReason !== "MERGED_INTO_ANOTHER_RIDE" || !payload.mergedIntoRideId) return current;
    return {
      ...current,
      ride: {
        ...current.ride,
        status: payload.status,
        cancelReason: payload.cancelReason,
        mergedIntoRideId: payload.mergedIntoRideId,
      },
    };
  }
  return { ...current, ride: { ...current.ride, status: payload.status } };
}

/** Seat statuses of a trip still going on (the driver undid a drop-off: back to PICKED_UP). */
export function isLiveSeatStatus(status: string): boolean {
  return status === "WAITING" || status === "ARRIVED" || status === "PICKED_UP";
}

/**
 * A `ride:passenger_status` event (sent only to the rider it is about)
 * applied to that rider's own seat — matched by seat id, so another
 * rider's seat in the same car is never touched. A live status for their
 * seat means their trip is going on (a drop-off the driver undid), so a fare
 * summary shown for it goes.
 */
export function withSeatStatus(
  current: GetRideResult | undefined,
  payload: PassengerStatusPayload,
): GetRideResult | undefined {
  if (!current) return current;
  const mine = current.ride.passengers.some((p) => p.id === payload.ridePassengerId);
  const { fareSummary: _undone, ...rest } = current;
  return {
    ...(mine && isLiveSeatStatus(payload.status) ? rest : current),
    ride: {
      ...current.ride,
      passengers: current.ride.passengers.map((p) =>
        p.id === payload.ridePassengerId ? { ...p, status: payload.status } : p,
      ),
    },
  };
}

/**
 * A `ride:completed` event: this rider's fare summary. It says THEIR trip is
 * complete (on a Shared car, sent at their own drop-off while others ride
 * on), so the car's status is left as it is.
 */
export function withFareSummary(
  current: GetRideResult | undefined,
  fareSummary: RideCompletedFareSummary,
): GetRideResult | undefined {
  return current ? { ...current, fareSummary } : current;
}

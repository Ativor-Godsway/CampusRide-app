import { getLoneFare, getSharedFarePerRider } from "@rida/shared";

/**
 * What a ride ACTUALLY costs, read from the fares stored on its seats — never
 * worked out again from today's price list (@rida/shared PRICING). A seat's
 * `lockedFare` is set when the rider asks for the ride (the price they were
 * shown), can only go down before departure, and is frozen from then on;
 * `fareCharged` copies it at drop-off. So a ride requested before a price
 * change keeps its price through offers, the trip, completion and the
 * driver's history, and only new requests get the new one.
 */

export type RideKind = "LONE" | "SHARED";

export interface SeatFare {
  status: string;
  lockedFare: number | null;
  fareCharged?: number | null;
}

/** Today's price for one seat, for a seat that has none stored (none should). */
export function currentSeatFare(type: RideKind): number {
  return type === "LONE" ? getLoneFare() : getSharedFarePerRider(1);
}

/** One seat's fare: charged at drop-off, else locked at request. */
export function seatFare(type: RideKind, seat: SeatFare): number {
  return seat.fareCharged ?? seat.lockedFare ?? currentSeatFare(type);
}

/**
 * The seats a completed ride is paid for. Shared: the riders actually dropped
 * off. Ride alone: its one rider, whose seat the ride-level /complete never
 * marks DROPPED_OFF.
 */
export function paidSeats<T extends SeatFare>(type: RideKind, seats: readonly T[]): T[] {
  return type === "LONE"
    ? seats.filter((s) => s.status !== "CANCELLED").slice(0, 1)
    : seats.filter((s) => s.status === "DROPPED_OFF");
}

/**
 * The fares a completed ride was paid, in pesewas. A Ride-alone ride with no
 * seat left (none should be) counts as one Ride-alone fare.
 */
export function paidFareTotal(type: RideKind, seats: readonly SeatFare[]): number {
  const paid = paidSeats(type, seats);
  if (type === "LONE" && paid.length === 0) return currentSeatFare("LONE");
  return paid.reduce((sum, s) => sum + seatFare(type, s), 0);
}

/**
 * A ride's fare as the admin site shows it, from the fares stored on its
 * seats (Ride.fareTotal is never written): a completed ride, what was paid
 * (final); a ride still going on, what its live seats will pay (not final
 * yet); a cancelled one, none.
 */
export function rideFareForAdmin(
  type: RideKind,
  status: string,
  seats: readonly SeatFare[],
): { pesewas: number | null; final: boolean } {
  if (status === "COMPLETED") return { pesewas: paidFareTotal(type, seats), final: true };
  if (status === "CANCELLED") return { pesewas: null, final: true };
  const live = seats.filter((s) => s.status !== "CANCELLED");
  if (live.length === 0) return { pesewas: null, final: false };
  return { pesewas: live.reduce((sum, s) => sum + seatFare(type, s), 0), final: false };
}

/**
 * The fare a waiting request was quoted: its requester's seat (a request has
 * just the one active seat). Used for the offer drivers see and for the seat
 * the rider takes when a driver adds them to a car.
 */
export function requestFare(
  type: RideKind,
  seats: readonly { riderId: string; status: string; lockedFare: number | null }[],
  riderId: string,
): number {
  const active = seats.filter((s) => s.status !== "CANCELLED");
  const seat = active.find((s) => s.riderId === riderId) ?? active[0];
  return seat?.lockedFare ?? currentSeatFare(type);
}

import { CAR_SEATS } from "./tripStops";

/**
 * Seats on a booking (2026-11-26). A rider can book a Shared ride for up to
 * three people (themself and two friends): one booking, one fare, N seats.
 * A Ride alone booking is the whole car and says how many people (1–4) so
 * the driver knows. A car holds CAR_SEATS (4) SEATS, not 4 bookings.
 *
 * Stored on the booking's seat row (RidePassenger.seats) and, while it is
 * still a request, on the request (Ride.occupancy). Older apps never send a
 * seat count: their bookings are 1 seat.
 */

/** Statuses in which a booking's seats are taken in the car. */
const SEATED = new Set(["WAITING", "ARRIVED", "PICKED_UP"]);

/** A booking's seats (1 when the server or app is older than seats). */
export function bookingSeats(booking: { seats?: number | null }): number {
  const n = booking.seats;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 ? n : 1;
}

/** Seats taken in a car: every booking still in it (waiting, arrived or on board). */
export function seatsTaken(bookings: readonly { status: string; seats?: number | null }[]): number {
  return bookings.reduce((sum, b) => (SEATED.has(b.status) ? sum + bookingSeats(b) : sum), 0);
}

/** Seats still free in a Shared car. */
export function freeSeatsIn(bookings: readonly { status: string; seats?: number | null }[], capacity = CAR_SEATS): number {
  return Math.max(0, capacity - seatsTaken(bookings));
}

/** "1 seat", "2 seats". */
export function seatsWord(n: number): string {
  return `${n} seat${n === 1 ? "" : "s"}`;
}

/** "1 person", "3 people". */
export function peopleWord(n: number): string {
  return n === 1 ? "1 person" : `${n} people`;
}

/** What a booking is, for drivers: "Shared · 2 seats", "Ride alone · 3 people" ("Ride alone" for one). */
export function bookingLabel(type: "LONE" | "SHARED", seats: number): string {
  if (type === "LONE") return seats > 1 ? `Ride alone · ${peopleWord(seats)}` : "Ride alone";
  return `Shared · ${seatsWord(seats)}`;
}

/** "3 of 4 seats taken" (the driver's trip screen). */
export function carSeatsLabel(taken: number, capacity = CAR_SEATS): string {
  return `${Math.min(taken, capacity)} of ${capacity} seats taken`;
}

/** Why a booking doesn't fit the free seats: "Needs 2 seats, you have 1." / "Your car is full." */
export function notEnoughSeatsText(needed: number, free: number): string {
  if (free <= 0) return "Your car is full.";
  return `Needs ${seatsWord(needed)}, you have ${free}.`;
}

/** The rider's own booking with its price: "2 seats · GH₵14" (a 1-seat booking: just the price). */
export function seatsWithPrice(seats: number, priceLabel: string): string {
  return seats > 1 ? `${seatsWord(seats)} · ${priceLabel}` : priceLabel;
}

import { peopleWord, seatsWord, type RideType } from "@rida/shared";

/**
 * Words for a booking with seats (2026-11-26): a Shared booking for the rider
 * and up to two friends, or Ride alone for 1–4 people. One price for all.
 */

/** "Request shared · GH₵14", "Request ride alone · GH₵15". */
export function requestLabel(type: RideType, priceLabel: string): string {
  return `Request ${type === "SHARED" ? "shared" : "ride alone"} · ${priceLabel}`;
}

/** A booking's price with its seats or people: "2 seats · GH₵14", "3 people · GH₵15"; one: the price alone. */
export function bookingPriceLabel(type: RideType, seats: number, priceLabel: string): string {
  if (seats <= 1) return priceLabel;
  return `${type === "LONE" ? peopleWord(seats) : seatsWord(seats)} · ${priceLabel}`;
}

import { PRICING } from "./pricing";

/**
 * Far-trip pricing (2026-11-24). Campus has two far ends:
 * - NORTH: Pentagon Hostel, TF Hall, Bani and Evandy Hostels (and what is
 *   beside them);
 * - SOUTH (Diaspora): Jean Nelson Aka, Elizabeth Frances Sey, Hilla Limann
 *   and Alexander Kwapong Halls (and what is beside them).
 * A Shared seat costs the far price ONLY on a trip from one end to the other
 * (North ↔ South, either way). Every other Shared trip — main campus to or
 * from either end, inside one end, main campus to main campus — pays the
 * normal price. Ride alone is the same price everywhere.
 *
 * The SERVER applies this, when the request is made (the price is locked on
 * the rider's seat then; rides already under way keep theirs). The apps show
 * the server's quote (POST /rides/quote) and never work it out themselves.
 * Both Shared prices, and which end each place is in, are admin settings.
 */

export const FAR_ENDS = ["NORTH", "SOUTH"] as const;
export type FarEnd = (typeof FAR_ENDS)[number];

export const FAR_END_LABELS: Record<FarEnd, string> = { NORTH: "North end", SOUTH: "South end (Diaspora)" };

/** Where each end of a trip is: a far end, or null for the rest of campus. */
export interface TripFarEnds {
  pickupFarEnd: FarEnd | null;
  dropoffFarEnd: FarEnd | null;
}

export interface SharedFarePrices {
  /** A normal Shared seat (GH₵7). */
  sharedPesewas: number;
  /** A Shared seat on a trip between the north and south ends (GH₵9). */
  sharedFarPesewas: number;
}

export const DEFAULT_SHARED_FARE_PRICES: SharedFarePrices = {
  sharedPesewas: PRICING.SHARED_FARES[1],
  sharedFarPesewas: 900,
};

/** The prices an admin may set, in pesewas: GH₵1 to GH₵100. */
export const SHARED_FARE_PRICE_BOUNDS = { min: 100, max: 10_000 } as const;

/** Whether a trip goes from one far end to the other (North ↔ South, either way). */
export function isFarTrip(ends: TripFarEnds): boolean {
  return ends.pickupFarEnd !== null && ends.dropoffFarEnd !== null && ends.pickupFarEnd !== ends.dropoffFarEnd;
}

/** One seat's price for a new request. Ride alone: always the Ride alone fare. */
export function seatPriceFor(type: "LONE" | "SHARED", ends: TripFarEnds, prices: SharedFarePrices): number {
  if (type === "LONE") return PRICING.LONE_FARE;
  return isFarTrip(ends) ? prices.sharedFarPesewas : prices.sharedPesewas;
}

/** Why a pair of prices can't be saved, or null. */
export function sharedFarePricesProblem(prices: SharedFarePrices): string | null {
  const ok = (v: number) => Number.isInteger(v) && v >= SHARED_FARE_PRICE_BOUNDS.min && v <= SHARED_FARE_PRICE_BOUNDS.max;
  if (!ok(prices.sharedPesewas) || !ok(prices.sharedFarPesewas)) return "Each price must be from GH₵1 to GH₵100.";
  if (prices.sharedFarPesewas > PRICING.LONE_FARE) return "A far Shared seat can't cost more than Ride alone.";
  return null;
}

/** What POST /rides/quote answers: the price of each ride type for this trip. */
export interface FareQuote {
  fares: { SHARED: number; LONE: number };
  /** The trip goes between the north and south ends of campus (Shared costs more). */
  farTrip: boolean;
}

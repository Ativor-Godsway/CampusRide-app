import { PRICING } from "./pricing";

/**
 * Far-trip pricing (2026-11-24). Some places are far from the rest of campus
 * (the "far area": Jean Nelson Aka, Elizabeth Frances Sey, Hilla Limann and
 * Alexander Kwapong Halls, Bani and Evandy Hostels, and their annexes). A
 * Shared seat costs more when the trip CROSSES between the far area and the
 * rest of campus — exactly one end inside it. A trip with both ends in the
 * far area, or neither, pays the normal Shared fare. Ride alone is the same
 * price everywhere.
 *
 * The SERVER applies this, when the request is made (the price is locked on
 * the rider's seat then; rides already under way keep theirs). The apps show
 * the server's quote (POST /rides/quote) and never work it out themselves.
 * Both Shared prices are admin settings (FarePricingSetting).
 */

export interface SharedFarePrices {
  /** A normal Shared seat (GH₵7). */
  sharedPesewas: number;
  /** A Shared seat on a trip crossing into or out of the far area (GH₵9). */
  sharedFarPesewas: number;
}

export const DEFAULT_SHARED_FARE_PRICES: SharedFarePrices = {
  sharedPesewas: PRICING.SHARED_FARES[1],
  sharedFarPesewas: 900,
};

/** The prices an admin may set, in pesewas: GH₵1 to GH₵100. */
export const SHARED_FARE_PRICE_BOUNDS = { min: 100, max: 10_000 } as const;

/** Whether a trip crosses: exactly one of its ends is in the far area. */
export function crossesFarArea(ends: { pickupInFarArea: boolean; dropoffInFarArea: boolean }): boolean {
  return ends.pickupInFarArea !== ends.dropoffInFarArea;
}

/** One seat's price for a new request. Ride alone: always the Ride alone fare. */
export function seatPriceFor(
  type: "LONE" | "SHARED",
  ends: { pickupInFarArea: boolean; dropoffInFarArea: boolean },
  prices: SharedFarePrices,
): number {
  if (type === "LONE") return PRICING.LONE_FARE;
  return crossesFarArea(ends) ? prices.sharedFarPesewas : prices.sharedPesewas;
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
  /** The trip crosses between the far area and the rest of campus (Shared costs more). */
  farTrip: boolean;
}

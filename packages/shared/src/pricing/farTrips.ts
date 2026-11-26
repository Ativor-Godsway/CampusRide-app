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
 * The prices, and which end each place is in, are admin settings. Since
 * 2026-11-26 Shared is priced by the seats in one booking (sharedFare) and
 * the far surcharge is per seat.
 */

export const FAR_ENDS = ["NORTH", "SOUTH"] as const;
export type FarEnd = (typeof FAR_ENDS)[number];

export const FAR_END_LABELS: Record<FarEnd, string> = { NORTH: "North end", SOUTH: "South end (Diaspora)" };

/** Where each end of a trip is: a far end, or null for the rest of campus. */
export interface TripFarEnds {
  pickupFarEnd: FarEnd | null;
  dropoffFarEnd: FarEnd | null;
}

/**
 * Every price an admin sets (Settings → Prices), in pesewas (2026-11-26).
 * Shared is priced by the seats in ONE booking (a rider bringing friends):
 * 1, 2 or 3 seats; a far trip adds `farPerSeatPesewas` for each seat. Ride
 * alone is one price for the whole car, whoever is in it (1–4 people).
 */
export interface FarePrices {
  /** A 1-seat Shared booking (GH₵7). */
  sharedPesewas: number;
  /** A 2-seat Shared booking (GH₵14). */
  shared2Pesewas: number;
  /** A 3-seat Shared booking (GH₵18). */
  shared3Pesewas: number;
  /** Added per seat on a trip between the north and south ends (GH₵2). */
  farPerSeatPesewas: number;
  /** Ride alone: the whole car (GH₵15). */
  lonePesewas: number;
}

/** @deprecated The old name: the same prices. */
export type SharedFarePrices = FarePrices;

export const DEFAULT_FARE_PRICES: FarePrices = {
  sharedPesewas: PRICING.SHARED_FARES[1],
  shared2Pesewas: 1400,
  shared3Pesewas: 1800,
  farPerSeatPesewas: 200,
  lonePesewas: PRICING.LONE_FARE,
};
/** @deprecated The old name. */
export const DEFAULT_SHARED_FARE_PRICES = DEFAULT_FARE_PRICES;

/** Seats one Shared booking may take (the rider and up to two friends). */
export const MAX_SHARED_BOOKING_SEATS = 3;
/** People one Ride alone booking may bring (the whole car). */
export const MAX_LONE_PEOPLE = 4;

/** The prices an admin may set, in pesewas: GH₵1 to GH₵100. */
export const SHARED_FARE_PRICE_BOUNDS = { min: 100, max: 10_000 } as const;
/** The far surcharge per seat: GH₵0 to GH₵20. */
export const FAR_PER_SEAT_BOUNDS = { min: 0, max: 2_000 } as const;

/** Whether a trip goes from one far end to the other (North ↔ South, either way). */
export function isFarTrip(ends: TripFarEnds): boolean {
  return ends.pickupFarEnd !== null && ends.dropoffFarEnd !== null && ends.pickupFarEnd !== ends.dropoffFarEnd;
}

/** The most seats (Shared) or people (Ride alone) one booking may have. */
export function maxBookingSeats(type: "LONE" | "SHARED"): number {
  return type === "LONE" ? MAX_LONE_PEOPLE : MAX_SHARED_BOOKING_SEATS;
}

/** Whether `seats` is a seat count (Shared) or party size (Ride alone) a booking may have. */
export function isValidBookingSeats(type: "LONE" | "SHARED", seats: unknown): seats is number {
  return typeof seats === "number" && Number.isInteger(seats) && seats >= 1 && seats <= maxBookingSeats(type);
}

/** A Shared booking of `seats` seats (1–3), far or not. */
export function sharedFare(seats: number, far: boolean, prices: FarePrices): number {
  const n = Math.min(MAX_SHARED_BOOKING_SEATS, Math.max(1, Math.floor(seats)));
  const base = n === 1 ? prices.sharedPesewas : n === 2 ? prices.shared2Pesewas : prices.shared3Pesewas;
  return base + (far ? prices.farPerSeatPesewas * n : 0);
}

/**
 * A new booking's price. Shared: by its seats, plus the far surcharge per
 * seat on a North ↔ South trip. Ride alone: always the Ride alone price,
 * however many people.
 */
export function bookingPriceFor(type: "LONE" | "SHARED", seats: number, ends: TripFarEnds, prices: FarePrices): number {
  if (type === "LONE") return prices.lonePesewas;
  return sharedFare(seats, isFarTrip(ends), prices);
}

/** One seat's price for a new request (a 1-seat booking). */
export function seatPriceFor(type: "LONE" | "SHARED", ends: TripFarEnds, prices: FarePrices): number {
  return bookingPriceFor(type, 1, ends, prices);
}

/** Why a set of prices can't be saved, or null. */
export function farePricesProblem(prices: FarePrices): string | null {
  const ok = (v: number) => Number.isInteger(v) && v >= SHARED_FARE_PRICE_BOUNDS.min && v <= SHARED_FARE_PRICE_BOUNDS.max;
  if (![prices.sharedPesewas, prices.shared2Pesewas, prices.shared3Pesewas, prices.lonePesewas].every(ok)) {
    return "Each price must be from GH₵1 to GH₵100.";
  }
  const far = prices.farPerSeatPesewas;
  if (!Number.isInteger(far) || far < FAR_PER_SEAT_BOUNDS.min || far > FAR_PER_SEAT_BOUNDS.max) {
    return "The far surcharge must be from GH₵0 to GH₵20 a seat.";
  }
  if (prices.shared2Pesewas < prices.sharedPesewas || prices.shared3Pesewas < prices.shared2Pesewas) {
    return "More seats can't cost less: 1 seat ≤ 2 seats ≤ 3 seats.";
  }
  if (prices.sharedPesewas + far > prices.lonePesewas) return "A 1-seat far Shared trip can't cost more than Ride alone.";
  return null;
}

/** @deprecated The old name. */
export const sharedFarePricesProblem = farePricesProblem;

/** What POST /rides/quote answers: the price of each ride type for this trip. */
export interface FareQuote {
  /** Shared: a 1-seat booking (what older apps show). Ride alone: the whole car. */
  fares: { SHARED: number; LONE: number };
  /**
   * Shared for 1, 2 and 3 seats in this booking (index 0 = 1 seat), far
   * surcharge included. Absent from older servers.
   */
  sharedBySeats?: [number, number, number];
  /** The trip goes between the north and south ends of campus (Shared costs more). */
  farTrip: boolean;
}

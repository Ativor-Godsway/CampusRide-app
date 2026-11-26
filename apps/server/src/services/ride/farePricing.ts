import type { Place, PrismaClient } from "@prisma/client";
import {
  DEFAULT_FARE_PRICES,
  NEAR_PLACE_METERS,
  PRICING,
  bookingPriceFor,
  isFarTrip,
  nearestPlace,
  sharedFare,
  type FarEnd,
  type FarePrices,
  type FareQuote,
  type LatLng,
  type RideType,
} from "@rida/shared";
import { clearPlaceCache, getActivePlaces } from "../places/placeCache";

/**
 * Prices (rules in @rida/shared pricing/farTrips): Shared is priced by the
 * seats in one booking (1, 2 or 3: GH₵7 / 14 / 18 by default, 2026-11-26),
 * plus a far surcharge per seat when the trip goes from one far end of
 * campus to the other (Place.farEnd NORTH ↔ SOUTH); Ride alone is one price
 * for the whole car (GH₵15, 1–4 people). Every price, and each place's end,
 * is an admin setting.
 *
 * Applied once, when the ride is requested (createRide, and a switch to
 * Shared): the price is locked on the rider's seat (RidePassenger.lockedFare),
 * and from then on everything — offers, the trip, the driver's 85%, the 15%
 * commission, history — reads that stored fare (services/ride/fares.ts). So a
 * price or far-area change never touches a ride already requested.
 *
 * Which place an end is at: the place the rider chose (while the pin stays
 * near it), else the nearest active place within NEAR_PLACE_METERS — the
 * place its label names ("Near Bani Hostel"). A pin with no place that near,
 * and a zone-only booking from an old app or USSD, is in neither end.
 */

const SETTING_ID = "fares";
const CACHE_MS = 30_000;
let cached: { at: number; value: FarePricing } | null = null;

export interface FarePricing extends FarePrices {
  /** When an admin last saved them, and who; null while the defaults apply. */
  updatedAt: Date | null;
  updatedBy: string | null;
}

/** The prices in force (the saved row, or the defaults). Cached briefly. */
export async function getFarePricing(prisma: PrismaClient): Promise<FarePricing> {
  if (cached && Date.now() - cached.at < CACHE_MS && process.env.NODE_ENV !== "test") return cached.value;
  const row = await prisma.farePricingSetting.findUnique({ where: { id: SETTING_ID } });
  const value: FarePricing = row
    ? {
        sharedPesewas: row.sharedPesewas,
        shared2Pesewas: row.shared2Pesewas,
        shared3Pesewas: row.shared3Pesewas,
        farPerSeatPesewas: row.farPerSeatPesewas,
        lonePesewas: row.lonePesewas,
        updatedAt: row.updatedAt,
        updatedBy: row.updatedBy,
      }
    : { ...DEFAULT_FARE_PRICES, updatedAt: null, updatedBy: null };
  cached = { at: Date.now(), value };
  return value;
}

export function clearFarePricingCache(): void {
  cached = null;
}

/** One end of a trip, as resolved for the ride (services/places/rideEnds). */
export interface PricedEnd extends LatLng {
  placeId: string | null;
}

/** The place an end is at or near, for pricing (see the header), or null. */
export function placeForEnd(end: PricedEnd, places: readonly Place[]): Place | null {
  if (end.placeId) {
    const chosen = places.find((p) => p.id === end.placeId);
    if (chosen) return chosen;
  }
  const near = nearestPlace(end, places);
  return near && near.meters <= NEAR_PLACE_METERS ? near.place : null;
}

/** The far end a trip end is in (NORTH / SOUTH), or null for the rest of campus. */
export function farEndOf(end: PricedEnd | null, places: readonly Place[]): FarEnd | null {
  if (!end) return null;
  return placeForEnd(end, places)?.farEnd ?? null;
}

/**
 * The price of each ride type for this trip now (null end: a zone-only
 * booking): Shared for a 1-seat booking (what older apps show) and for 1, 2
 * and 3 seats; Ride alone for the whole car.
 */
export async function quoteFares(
  prisma: PrismaClient,
  pickup: PricedEnd | null,
  dropoff: PricedEnd | null,
): Promise<FareQuote & { sharedBySeats: [number, number, number] }> {
  const [prices, places] = await Promise.all([getFarePricing(prisma), getActivePlaces(prisma)]);
  const ends = { pickupFarEnd: farEndOf(pickup, places), dropoffFarEnd: farEndOf(dropoff, places) };
  const far = isFarTrip(ends);
  return {
    fares: { SHARED: bookingPriceFor("SHARED", 1, ends, prices), LONE: bookingPriceFor("LONE", 1, ends, prices) },
    sharedBySeats: [sharedFare(1, far, prices), sharedFare(2, far, prices), sharedFare(3, far, prices)],
    farTrip: far,
  };
}

/** A booking's price from a quote: Shared by its seats, Ride alone whatever the party. */
export function quotedBookingFare(quote: FareQuote & { sharedBySeats: [number, number, number] }, type: RideType, seats: number): number {
  return type === "LONE" ? quote.fares.LONE : quote.sharedBySeats[Math.min(3, Math.max(1, seats)) - 1]!;
}

/**
 * The price the app showed changed before the request arrived (an admin
 * changed a price, or a far end, a moment ago). Nothing is booked; the
 * app shows `message` and asks for a new quote.
 */
export class FareChangedError extends Error {
  readonly code = "FARE_CHANGED";
  constructor(readonly farePesewas: number) {
    super(`The price for this trip has just changed to GH₵${(farePesewas / 100).toFixed(farePesewas % 100 === 0 ? 0 : 2)}. Check it and request again.`);
    this.name = "FareChangedError";
  }
}

/** What an app that shows no quote (rider builds before 2026-11-24, USSD) shows: a Shared seat, and Ride alone. */
export const LEGACY_SHOWN_SHARED_FARE = PRICING.SHARED_FARES[1];
export const LEGACY_SHOWN_LONE_FARE = PRICING.LONE_FARE;

/**
 * The fare to lock on a new booking of this type and size for this trip
 * (one fare for all its seats) — never more than the rider was shown:
 * - `shownFare` given (current rider apps send the quote they showed): it must
 *   be today's price for these seats, else FareChangedError;
 * - none (older rider apps, which work the price out on the phone, and USSD;
 *   always 1 seat): at most the GH₵7 / GH₵15 they show, so nobody is charged
 *   more than their screen said while the update reaches phones.
 */
export async function fareForNewBooking(
  prisma: PrismaClient,
  type: RideType,
  seats: number,
  pickup: PricedEnd | null,
  dropoff: PricedEnd | null,
  shownFare?: number | null,
): Promise<number> {
  const fare = quotedBookingFare(await quoteFares(prisma, pickup, dropoff), type, seats);
  if (shownFare !== undefined && shownFare !== null) {
    if (shownFare !== fare) throw new FareChangedError(fare);
    return fare;
  }
  return Math.min(fare, type === "SHARED" ? LEGACY_SHOWN_SHARED_FARE * seats : LEGACY_SHOWN_LONE_FARE);
}

/** A 1-seat booking (older callers). */
export function fareForNewSeat(
  prisma: PrismaClient,
  type: RideType,
  pickup: PricedEnd | null,
  dropoff: PricedEnd | null,
  shownFare?: number | null,
): Promise<number> {
  return fareForNewBooking(prisma, type, 1, pickup, dropoff, shownFare);
}

/**
 * Saves the prices and the far ends (exactly these places, each NORTH or
 * SOUTH; every other place in neither) together, with one audit row saying
 * what changed.
 */
export async function saveFarePricing(
  prisma: PrismaClient,
  input: FarePrices & { farPlaces: Array<{ placeId: string; end: FarEnd }> },
  adminId: string,
): Promise<void> {
  const ids = input.farPlaces.map((p) => p.placeId);
  const [before, beforePlaces, named] = await Promise.all([
    getFarePricing(prisma),
    prisma.place.findMany({ where: { farEnd: { not: null } }, select: { id: true, name: true, farEnd: true } }),
    prisma.place.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
  ]);
  const wanted = new Map(input.farPlaces.map((p) => [p.placeId, p.end]));
  const nameOf = new Map([...beforePlaces, ...named].map((p) => [p.id, p.name]));
  const was = new Map(beforePlaces.map((p) => [p.id, p.farEnd]));
  const moved = [...wanted].filter(([id, end]) => was.get(id) !== end).map(([id, end]) => `${nameOf.get(id)} → ${end.toLowerCase()}`);
  const removed = beforePlaces.filter((p) => !wanted.has(p.id)).map((p) => `${p.name} → none`);
  const priceNames: Array<[keyof FarePrices, string]> = [
    ["sharedPesewas", "Shared 1 seat"],
    ["shared2Pesewas", "Shared 2 seats"],
    ["shared3Pesewas", "Shared 3 seats"],
    ["farPerSeatPesewas", "far per seat"],
    ["lonePesewas", "Ride alone"],
  ];
  const changes = [
    ...priceNames.map(([key, name]) => (before[key] !== input[key] ? `${name} ${before[key]} → ${input[key]}` : null)),
    moved.length || removed.length ? `far ends: ${[...moved, ...removed].join(", ")}` : null,
  ].filter(Boolean);
  const data = {
    sharedPesewas: input.sharedPesewas,
    shared2Pesewas: input.shared2Pesewas,
    shared3Pesewas: input.shared3Pesewas,
    farPerSeatPesewas: input.farPerSeatPesewas,
    lonePesewas: input.lonePesewas,
    // In step for anything still reading the old column.
    sharedFarPesewas: input.sharedPesewas + input.farPerSeatPesewas,
    updatedBy: adminId,
  };
  const ofEnd = (end: FarEnd) => [...wanted].filter(([, e]) => e === end).map(([id]) => id);
  await prisma.$transaction([
    prisma.farePricingSetting.upsert({ where: { id: SETTING_ID }, create: { id: SETTING_ID, ...data }, update: data }),
    prisma.place.updateMany({ where: { farEnd: { not: null }, id: { notIn: ids } }, data: { farEnd: null } }),
    prisma.place.updateMany({ where: { id: { in: ofEnd("NORTH") } }, data: { farEnd: "NORTH" } }),
    prisma.place.updateMany({ where: { id: { in: ofEnd("SOUTH") } }, data: { farEnd: "SOUTH" } }),
    prisma.adminAuditLog.create({
      data: {
        actor: adminId,
        action: "fares.update",
        target: SETTING_ID,
        reason: (changes.length ? changes.join("; ") : "no change").slice(0, 1000),
      },
    }),
  ]);
  clearFarePricingCache();
  clearPlaceCache(prisma);
}

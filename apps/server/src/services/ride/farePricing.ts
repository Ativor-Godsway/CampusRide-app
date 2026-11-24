import type { Place, PrismaClient } from "@prisma/client";
import {
  DEFAULT_SHARED_FARE_PRICES,
  NEAR_PLACE_METERS,
  PRICING,
  crossesFarArea,
  nearestPlace,
  seatPriceFor,
  type FareQuote,
  type LatLng,
  type RideType,
  type SharedFarePrices,
} from "@rida/shared";
import { clearPlaceCache, getActivePlaces } from "../places/placeCache";

/**
 * Far-trip pricing (2026-11-24, rules in @rida/shared pricing/farTrips): a
 * Shared seat costs the far price when exactly one end of the trip is in the
 * far area (Place.inFarArea), the normal price otherwise; Ride alone is
 * always PRICING.LONE_FARE. Both Shared prices are admin settings.
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
 * and a zone-only booking from an old app or USSD, isn't in the far area.
 */

const SETTING_ID = "fares";
const CACHE_MS = 30_000;
let cached: { at: number; value: FarePricing } | null = null;

export interface FarePricing extends SharedFarePrices {
  /** When an admin last saved them, and who; null while the defaults apply. */
  updatedAt: Date | null;
  updatedBy: string | null;
}

/** The Shared prices in force (the saved row, or GH₵7 / GH₵9). Cached briefly. */
export async function getFarePricing(prisma: PrismaClient): Promise<FarePricing> {
  if (cached && Date.now() - cached.at < CACHE_MS && process.env.NODE_ENV !== "test") return cached.value;
  const row = await prisma.farePricingSetting.findUnique({ where: { id: SETTING_ID } });
  const value: FarePricing = row
    ? { sharedPesewas: row.sharedPesewas, sharedFarPesewas: row.sharedFarPesewas, updatedAt: row.updatedAt, updatedBy: row.updatedBy }
    : { ...DEFAULT_SHARED_FARE_PRICES, updatedAt: null, updatedBy: null };
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

export function endInFarArea(end: PricedEnd | null, places: readonly Place[]): boolean {
  if (!end) return false;
  return placeForEnd(end, places)?.inFarArea ?? false;
}

/** The price of each ride type for this trip now (null end: a zone-only booking). */
export async function quoteFares(
  prisma: PrismaClient,
  pickup: PricedEnd | null,
  dropoff: PricedEnd | null,
): Promise<FareQuote> {
  const [prices, places] = await Promise.all([getFarePricing(prisma), getActivePlaces(prisma)]);
  const ends = { pickupInFarArea: endInFarArea(pickup, places), dropoffInFarArea: endInFarArea(dropoff, places) };
  return {
    fares: { SHARED: seatPriceFor("SHARED", ends, prices), LONE: PRICING.LONE_FARE },
    farTrip: crossesFarArea(ends),
  };
}

/**
 * The price the app showed changed before the request arrived (an admin
 * changed a price, or the far area, a moment ago). Nothing is booked; the
 * app shows `message` and asks for a new quote.
 */
export class FareChangedError extends Error {
  readonly code = "FARE_CHANGED";
  constructor(readonly farePesewas: number) {
    super(`The price for this trip has just changed to GH₵${(farePesewas / 100).toFixed(farePesewas % 100 === 0 ? 0 : 2)}. Check it and request again.`);
    this.name = "FareChangedError";
  }
}

/** What an app that shows no quote (rider builds before 2026-11-24, USSD) shows for a Shared seat. */
export const LEGACY_SHOWN_SHARED_FARE = PRICING.SHARED_FARES[1];

/**
 * The fare to lock on a new seat of this type for this trip — never more than
 * the rider was shown:
 * - `shownFare` given (current rider apps send the quote they showed): it must
 *   be today's price, else FareChangedError;
 * - none (older rider apps, which work the price out on the phone, and USSD):
 *   at most the GH₵7 they show for Shared, so nobody is charged more than
 *   their screen said while the update reaches phones.
 */
export async function fareForNewSeat(
  prisma: PrismaClient,
  type: RideType,
  pickup: PricedEnd | null,
  dropoff: PricedEnd | null,
  shownFare?: number | null,
): Promise<number> {
  const fare = (await quoteFares(prisma, pickup, dropoff)).fares[type];
  if (shownFare !== undefined && shownFare !== null) {
    if (shownFare !== fare) throw new FareChangedError(fare);
    return fare;
  }
  return type === "SHARED" ? Math.min(fare, LEGACY_SHOWN_SHARED_FARE) : fare;
}

/**
 * Saves the prices and the far area (exactly `farPlaceIds`) together, with
 * one audit row saying what changed.
 */
export async function saveFarePricing(
  prisma: PrismaClient,
  input: SharedFarePrices & { farPlaceIds: string[] },
  adminId: string,
): Promise<void> {
  const [before, beforePlaces, named] = await Promise.all([
    getFarePricing(prisma),
    prisma.place.findMany({ where: { inFarArea: true }, select: { id: true, name: true } }),
    prisma.place.findMany({ where: { id: { in: input.farPlaceIds } }, select: { id: true, name: true } }),
  ]);
  const wanted = new Set(named.map((p) => p.id));
  const added = named.filter((p) => !beforePlaces.some((b) => b.id === p.id)).map((p) => p.name);
  const removed = beforePlaces.filter((p) => !wanted.has(p.id)).map((p) => p.name);
  const changes = [
    before.sharedPesewas !== input.sharedPesewas ? `Shared ${before.sharedPesewas} → ${input.sharedPesewas}` : null,
    before.sharedFarPesewas !== input.sharedFarPesewas ? `far Shared ${before.sharedFarPesewas} → ${input.sharedFarPesewas}` : null,
    added.length ? `far area + ${added.join(", ")}` : null,
    removed.length ? `far area − ${removed.join(", ")}` : null,
  ].filter(Boolean);
  const data = { sharedPesewas: input.sharedPesewas, sharedFarPesewas: input.sharedFarPesewas, updatedBy: adminId };
  await prisma.$transaction([
    prisma.farePricingSetting.upsert({ where: { id: SETTING_ID }, create: { id: SETTING_ID, ...data }, update: data }),
    prisma.place.updateMany({ where: { inFarArea: true, id: { notIn: [...wanted] } }, data: { inFarArea: false } }),
    prisma.place.updateMany({ where: { id: { in: [...wanted] } }, data: { inFarArea: true } }),
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

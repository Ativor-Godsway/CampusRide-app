import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  PINNED_LOCATION_LABEL,
  isInServiceArea,
  labelForPoint,
  nearestZone,
  type RefusedBookingReason,
  type RefusedBookingStage,
  type RideType,
} from "@rida/shared";
import { logger } from "../../lib/logger";
import { getActivePlaces } from "../places/placeCache";
import { getActiveZones } from "../zones/zoneCache";
import type { RideEndInput } from "../places/rideEnds";

/**
 * Refused bookings (@rida/shared rides/refusedBookings): an anonymous record
 * of each ride request the server refused — when, the two ends as a place
 * name and zone, and why. Nothing that says who asked is stored: no rider
 * id, no phone, no exact pin (a pin is kept only as the place it's at or
 * near, "Near Bani Hostel", and its zone).
 *
 * The QUOTE stage is counted once per rider, trip and reason per
 * QUOTE_REPEAT_MS (a rider nudging the pin asks for a new quote each time).
 * That check is in this server's memory only, as a one-way hash, and is
 * never written anywhere.
 */

export const QUOTE_REPEAT_MS = 30 * 60_000;
const MAX_REMEMBERED = 10_000;
const seenQuotes = new Map<string, number>();

export interface RefusedBookingInput {
  reason: RefusedBookingReason;
  stage: RefusedBookingStage;
  rideType?: RideType | null;
  pickup?: RideEndInput | null;
  dropoff?: RideEndInput | null;
  /** Zone-only bookings (older apps, USSD). */
  pickupZoneId?: string | null;
  dropoffZoneId?: string | null;
}

interface EndRecord {
  label: string | null;
  zoneId: string | null;
}

async function describeEnd(prisma: PrismaClient, end: RideEndInput | null | undefined, zoneId: string | null | undefined): Promise<EndRecord> {
  const [places, zones] = await Promise.all([getActivePlaces(prisma), getActiveZones(prisma)]);
  const place = end?.placeId ? places.find((p) => p.id === end.placeId) : undefined;
  const point =
    end?.latitude !== undefined && end.longitude !== undefined
      ? { latitude: end.latitude, longitude: end.longitude }
      : place
        ? { latitude: place.latitude, longitude: place.longitude }
        : null;
  if (point) {
    const label = place?.name ?? labelForPoint(point, places);
    return {
      label: label === PINNED_LOCATION_LABEL ? null : label,
      // Off campus: no zone (that's often why it was refused).
      zoneId: isInServiceArea(point) ? (nearestZone(point.latitude, point.longitude, zones)?.id ?? null) : null,
    };
  }
  return { label: null, zoneId: zoneId && zones.some((z) => z.id === zoneId) ? zoneId : null };
}

/** Records one refusal. Never throws: a refused booking is answered whatever happens here. */
export async function recordRefusedBooking(prisma: PrismaClient, input: RefusedBookingInput, now: Date = new Date()): Promise<void> {
  try {
    const [pickup, dropoff] = await Promise.all([
      describeEnd(prisma, input.pickup, input.pickupZoneId),
      describeEnd(prisma, input.dropoff, input.dropoffZoneId),
    ]);
    await prisma.refusedBooking.create({
      data: {
        createdAt: now,
        reason: input.reason,
        stage: input.stage,
        rideType: input.rideType ?? null,
        pickupLabel: pickup.label?.slice(0, 160) ?? null,
        pickupZoneId: pickup.zoneId,
        dropoffLabel: dropoff.label?.slice(0, 160) ?? null,
        dropoffZoneId: dropoff.zoneId,
      },
    });
  } catch (err) {
    logger.warn("refused booking: record failed", { reason: input.reason, err });
  }
}

function endKey(end: RideEndInput | null | undefined): string {
  if (!end) return "-";
  if (end.latitude !== undefined && end.longitude !== undefined) {
    // ~100 m: the same trip, however the pin was nudged.
    return `${end.latitude.toFixed(3)},${end.longitude.toFixed(3)}`;
  }
  return end.placeId ?? "-";
}

/**
 * Whether this rider's quote for this trip and reason was already counted in
 * the last QUOTE_REPEAT_MS (and remembers it if not).
 */
export function quoteAlreadyCounted(riderId: string, input: RefusedBookingInput, now: number = Date.now()): boolean {
  const key = createHash("sha256")
    .update(`${riderId}|${input.reason}|${endKey(input.pickup)}|${endKey(input.dropoff)}`)
    .digest("base64url");
  const seenAt = seenQuotes.get(key);
  if (seenAt !== undefined && now - seenAt < QUOTE_REPEAT_MS) return true;
  seenQuotes.set(key, now);
  if (seenQuotes.size > MAX_REMEMBERED) {
    for (const [k, at] of seenQuotes) if (now - at >= QUOTE_REPEAT_MS) seenQuotes.delete(k);
    while (seenQuotes.size > MAX_REMEMBERED) seenQuotes.delete(seenQuotes.keys().next().value!);
  }
  return false;
}

/** Tests only. */
export function resetRefusedBookingsForTests(): void {
  seenQuotes.clear();
}

export interface RefusedBookingCounts {
  /** Accra days (YYYY-MM-DD), oldest first, each with a count per reason. */
  days: Array<{ day: string; total: number; byReason: Partial<Record<RefusedBookingReason, number>>; requests: number; quotes: number }>;
  byReason: Array<{ reason: string; total: number; requests: number; quotes: number }>;
  total: number;
  /** The most refused pickup zones over the period. */
  topPickupZones: Array<{ zoneId: string | null; total: number }>;
}

/** Counts per day and per reason over [from, to), days in `dayOf` (Accra). */
export async function refusedBookingCounts(
  prisma: PrismaClient,
  period: { from: Date; to: Date },
  dayOf: (d: Date) => string,
  days: readonly string[],
): Promise<RefusedBookingCounts> {
  const rows = await prisma.refusedBooking.findMany({
    where: { createdAt: { gte: period.from, lt: period.to } },
    select: { createdAt: true, reason: true, stage: true, pickupZoneId: true },
  });
  const perDay = new Map(days.map((d) => [d, { day: d, total: 0, byReason: {} as Partial<Record<RefusedBookingReason, number>>, requests: 0, quotes: 0 }]));
  const perReason = new Map<string, { reason: string; total: number; requests: number; quotes: number }>();
  const perZone = new Map<string | null, number>();
  for (const r of rows) {
    const day = perDay.get(dayOf(r.createdAt));
    const isQuote = r.stage === "QUOTE";
    if (day) {
      day.total += 1;
      day.byReason[r.reason as RefusedBookingReason] = (day.byReason[r.reason as RefusedBookingReason] ?? 0) + 1;
      if (isQuote) day.quotes += 1;
      else day.requests += 1;
    }
    const reason = perReason.get(r.reason) ?? { reason: r.reason, total: 0, requests: 0, quotes: 0 };
    reason.total += 1;
    if (isQuote) reason.quotes += 1;
    else reason.requests += 1;
    perReason.set(r.reason, reason);
    perZone.set(r.pickupZoneId, (perZone.get(r.pickupZoneId) ?? 0) + 1);
  }
  return {
    days: [...perDay.values()],
    byReason: [...perReason.values()].sort((a, b) => b.total - a.total),
    total: rows.length,
    topPickupZones: [...perZone.entries()]
      .map(([zoneId, total]) => ({ zoneId, total }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 8),
  };
}

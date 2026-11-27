import type { Prisma, PrismaClient, ScheduledBooking, ScheduledCar } from "@prisma/client";
import {
  estimateEtaMinutes,
  leaveByFor,
  neighboursFrom,
  scheduleBlockUntil,
  strikesBlock,
  strikesCountFrom,
  type AreNeighbours,
  type GroupableBooking,
} from "@rida/shared";
import { logger } from "../../lib/logger";
import { getZoneAdjacency, getZoneMap } from "../zones/zoneCache";
import { scheduleSettings } from "./settings";

/**
 * Scheduled Shared rides (2026-11-27): what the rest of services/scheduled
 * shares. The rules are in @rida/shared rides/scheduled.ts.
 *
 * Tables: ScheduledCar (one per car in a slot), ScheduledBooking (a rider's
 * 1–3 seats in it), ScheduleStrike, ScheduledRideEvent (the analysis log),
 * ScheduleSetting. A car becomes a normal Ride when it starts (Ride.booking
 * SCHEDULED, scheduledCarId); a seat that becomes a live request is a normal
 * request (Ride.booking SCHEDULED_TO_LIVE).
 */

export type CarWithBookings = ScheduledCar & { bookings: ScheduledBooking[] };

/** Cars still to happen (bookings can join; the tick looks after them). */
export const UPCOMING_CAR_STATUSES = ["OPEN", "ACCEPTED"] as const;

/** A refused scheduled-ride action: an HTTP status, a code for the app and words for the rider or driver. */
export class ScheduleError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number = 409,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ScheduleError";
  }
}

/** The bookings still in a car. */
export function bookedOf(car: { bookings: ScheduledBooking[] }): ScheduledBooking[] {
  return car.bookings.filter((b) => b.status === "BOOKED");
}

export function seatsOf(bookings: ReadonlyArray<{ seats: number }>): number {
  return bookings.reduce((sum, b) => sum + b.seats, 0);
}

export function lockedTotal(bookings: ReadonlyArray<{ lockedFare: number }>): number {
  return bookings.reduce((sum, b) => sum + b.lockedFare, 0);
}

/** A booking as the grouping rules see it. */
export function groupable(b: Pick<ScheduledBooking, "pickupZoneId" | "pickupLat" | "pickupLng" | "dropoffZoneId" | "dropoffLat" | "dropoffLng" | "seats">): GroupableBooking {
  return {
    pickup: { zoneId: b.pickupZoneId, latitude: b.pickupLat, longitude: b.pickupLng },
    dropoff: { zoneId: b.dropoffZoneId, latitude: b.dropoffLat, longitude: b.dropoffLng },
    seats: b.seats,
  };
}

/** Zone neighbours in service, either way round (the dispatch ones). */
export async function zoneNeighbours(prisma: PrismaClient): Promise<AreNeighbours> {
  return neighboursFrom(await getZoneAdjacency(prisma));
}

/** Minutes for the longest pickup → drop-off in the car (pins, else zone centres). */
export async function tripMinutesFor(prisma: PrismaClient, bookings: readonly ScheduledBooking[]): Promise<number> {
  const zones = await getZoneMap(prisma);
  const point = (lat: number | null, lng: number | null, zoneId: string) => {
    if (lat != null && lng != null) return { latitude: lat, longitude: lng };
    const z = zones.get(zoneId);
    return z ? { latitude: z.latitude, longitude: z.longitude } : null;
  };
  let longest = 0;
  for (const b of bookings) {
    const m = estimateEtaMinutes(point(b.pickupLat, b.pickupLng, b.pickupZoneId), point(b.dropoffLat, b.dropoffLng, b.dropoffZoneId));
    if (m !== null) longest = Math.max(longest, m);
  }
  // Nothing to go on: a typical campus trip.
  return longest || 8;
}

/** The car's leave-by time for these bookings (never before `now`). */
export async function leaveByForCar(prisma: PrismaClient, arriveBy: Date, bookings: readonly ScheduledBooking[], now: Date): Promise<Date> {
  const trip = await tripMinutesFor(prisma, bookings);
  return new Date(leaveByFor(arriveBy.getTime(), trip, bookings.length, scheduleSettings(), now.getTime()));
}

type Db = PrismaClient | Prisma.TransactionClient;

/** One line in the analysis log. Never throws (a failed log line never undoes a booking). */
export async function logScheduleEvent(
  db: Db,
  event: { carId: string; kind: string; bookingId?: string | null; detail?: string | null },
): Promise<void> {
  try {
    await db.scheduledRideEvent.create({
      data: { carId: event.carId, kind: event.kind, bookingId: event.bookingId ?? null, detail: event.detail?.slice(0, 200) ?? null },
    });
  } catch (err) {
    logger.warn("scheduled: event log failed", { err, kind: event.kind, carId: event.carId });
  }
}

/**
 * A late cancel or a no-show: one strike (once per booking and kind). With
 * enough strikes since the window began (or the last block), the rider is
 * stopped from scheduling for `blockDays`. Returns when they're blocked
 * until, if this strike blocked them.
 */
export async function addStrike(
  prisma: PrismaClient,
  strike: { riderId: string; bookingId: string; carId: string; kind: "LATE_CANCEL" | "NO_SHOW" },
  now: Date = new Date(),
): Promise<{ blockedUntil: Date | null }> {
  const s = scheduleSettings();
  const { count } = await prisma.scheduleStrike.createMany({
    data: [{ riderId: strike.riderId, bookingId: strike.bookingId, kind: strike.kind, createdAt: now }],
    skipDuplicates: true,
  });
  if (count === 0) return { blockedUntil: null };
  await logScheduleEvent(prisma, { carId: strike.carId, bookingId: strike.bookingId, kind: "STRIKE", detail: strike.kind });

  const user = await prisma.user.findUnique({
    where: { id: strike.riderId },
    select: { scheduleBlockedAt: true, scheduleBlockedUntil: true },
  });
  if (user?.scheduleBlockedUntil && user.scheduleBlockedUntil > now) return { blockedUntil: null };
  const from = new Date(strikesCountFrom(now.getTime(), s, user?.scheduleBlockedAt?.getTime() ?? null));
  const strikes = await prisma.scheduleStrike.count({ where: { riderId: strike.riderId, createdAt: { gte: from } } });
  if (!strikesBlock(strikes, s)) return { blockedUntil: null };

  const until = new Date(scheduleBlockUntil(now.getTime(), s));
  await prisma.user.update({ where: { id: strike.riderId }, data: { scheduleBlockedAt: now, scheduleBlockedUntil: until } });
  await logScheduleEvent(prisma, { carId: strike.carId, bookingId: strike.bookingId, kind: "BLOCKED", detail: `${strikes} strikes` });
  return { blockedUntil: until };
}

/** Strikes that count against this rider now (the cancel sheet's warning). */
export async function strikesNow(prisma: PrismaClient, riderId: string, now: Date = new Date()): Promise<number> {
  const user = await prisma.user.findUnique({ where: { id: riderId }, select: { scheduleBlockedAt: true } });
  const from = new Date(strikesCountFrom(now.getTime(), scheduleSettings(), user?.scheduleBlockedAt?.getTime() ?? null));
  return prisma.scheduleStrike.count({ where: { riderId, createdAt: { gte: from } } });
}

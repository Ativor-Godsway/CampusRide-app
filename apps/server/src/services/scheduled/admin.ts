import type { PrismaClient } from "@prisma/client";
import { accraDay, startOfAccraDay } from "../admin/period";
import { seatsOf } from "./core";

const DAY_MS = 24 * 60 * 60_000;

/**
 * Admin site → Scheduled: one Accra day by slot and car (seats, status,
 * driver, leave-by, why it went live), that day's totals (bookings, seats,
 * cars, accepted, started, converted to live, no-shows, late cancels,
 * strikes) and the same counts for the last 14 days. No phones or pins.
 */
export async function scheduledDayForAdmin(prisma: PrismaClient, day: string | null, now: Date = new Date()) {
  const key = day ?? accraDay(now);
  const from = startOfAccraDay(key) ?? new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS);
  const to = new Date(from.getTime() + DAY_MS);
  const recentFrom = new Date(from.getTime() - 13 * DAY_MS);

  const [cars, strikes, blocked, recentBookings, recentCars, recentStrikes] = await Promise.all([
    prisma.scheduledCar.findMany({
      where: { arriveBy: { gte: from, lt: to } },
      include: { bookings: true, driver: { select: { name: true } } },
      orderBy: [{ arriveBy: "asc" }, { createdAt: "asc" }],
    }),
    prisma.scheduleStrike.count({ where: { createdAt: { gte: from, lt: to } } }),
    prisma.user.count({ where: { scheduleBlockedUntil: { gt: now } } }),
    prisma.scheduledBooking.findMany({
      where: { arriveBy: { gte: recentFrom, lt: to } },
      select: { arriveBy: true, seats: true, status: true, noShowAt: true, lateCancel: true },
    }),
    prisma.scheduledCar.findMany({ where: { arriveBy: { gte: recentFrom, lt: to } }, select: { arriveBy: true, status: true, acceptedAt: true, startedAt: true } }),
    prisma.scheduleStrike.findMany({ where: { createdAt: { gte: recentFrom, lt: to } }, select: { createdAt: true } }),
  ]);

  const bookings = cars.flatMap((c) => c.bookings);
  const kept = bookings.filter((b) => b.status !== "CANCELLED");
  const totals = {
    bookings: bookings.length,
    seats: seatsOf(kept),
    cars: cars.filter((c) => c.bookings.length > 0).length,
    accepted: cars.filter((c) => c.acceptedAt !== null || c.status === "STARTED").length,
    started: cars.filter((c) => c.status === "STARTED").length,
    toLive: bookings.filter((b) => b.status === "LIVE").length,
    carsToLive: cars.filter((c) => c.status === "LIVE").length,
    noShows: bookings.filter((b) => b.noShowAt !== null).length,
    lateCancels: bookings.filter((b) => b.lateCancel).length,
    cancels: bookings.filter((b) => b.status === "CANCELLED").length,
    strikes,
    blockedRiders: blocked,
  };

  const slots = new Map<string, Array<Record<string, unknown>>>();
  for (const c of cars) {
    const at = c.arriveBy.toISOString();
    const live = c.bookings.filter((b) => b.status !== "CANCELLED");
    slots.set(at, [
      ...(slots.get(at) ?? []),
      {
        id: c.id,
        status: c.status,
        seats: seatsOf(live),
        bookings: live.length,
        cancelled: c.bookings.length - live.length,
        noShows: c.bookings.filter((b) => b.noShowAt !== null).length,
        driverName: c.driver?.name ?? null,
        acceptedVia: c.acceptedVia,
        offeredAt: c.offeredAt?.toISOString() ?? null,
        leaveBy: c.leaveBy?.toISOString() ?? null,
        liveReason: c.liveReason,
        rideId: c.rideId,
      },
    ]);
  }

  const recent = Array.from({ length: 14 }, (_, i) => {
    const start = recentFrom.getTime() + i * DAY_MS;
    const inDay = (d: Date) => d.getTime() >= start && d.getTime() < start + DAY_MS;
    const b = recentBookings.filter((x) => inDay(x.arriveBy));
    const c = recentCars.filter((x) => inDay(x.arriveBy));
    return {
      day: accraDay(new Date(start)),
      bookings: b.length,
      seats: seatsOf(b.filter((x) => x.status !== "CANCELLED")),
      cars: c.length,
      started: c.filter((x) => x.status === "STARTED").length,
      toLive: b.filter((x) => x.status === "LIVE").length,
      noShows: b.filter((x) => x.noShowAt !== null).length,
      strikes: recentStrikes.filter((x) => inDay(x.createdAt)).length,
    };
  });

  return { day: key, totals, slots: [...slots].map(([arriveBy, list]) => ({ arriveBy, cars: list })), recent };
}

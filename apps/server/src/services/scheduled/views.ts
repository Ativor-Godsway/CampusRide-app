import type { PrismaClient, ScheduledBooking, ScheduledCar } from "@prisma/client";
import {
  bookingFitsCar,
  firstName,
  freeCancelUntil,
  pickupWindowFor,
  scheduleBlockedText,
  scheduleOverlapText,
  scheduleOverlaps,
  scheduleSlots,
  scheduledOfferLabel,
  splitFare,
  SCHEDULE_DAYS,
  type DriverScheduledCarView,
  type GroupableBooking,
  type ScheduleOptions,
  type ScheduledBookingState,
  type ScheduledBookingView,
} from "@rida/shared";
import { readServiceHours } from "../service/serviceHours";
import { getZoneMap } from "../zones/zoneCache";
import { bookedOf, groupable, lockedTotal, seatsOf, zoneNeighbours, type CarWithBookings } from "./core";
import { scheduleSettings } from "./settings";

const DAY_MS = 24 * 60 * 60_000;

/** "Balme Library", or "Balme Library +1" when the car has more than one place at that end. */
export function areaName(bookings: ReadonlyArray<Pick<ScheduledBooking, "pickupLabel" | "dropoffLabel">>, end: "pickup" | "dropoff", fallback = "Campus"): string {
  const names = [...new Set(bookings.map((b) => (end === "pickup" ? b.pickupLabel : b.dropoffLabel)).filter((n): n is string => Boolean(n)))];
  if (names.length === 0) return fallback;
  return names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0]!;
}

/** A car as a driver sees it (an offer, the board, the Schedule tab). Never a rider's pin. */
export async function driverCarView(
  prisma: PrismaClient,
  car: CarWithBookings,
  ctx: { viewerId: string | null; held: readonly number[]; online: boolean; now: Date },
): Promise<DriverScheduledCarView> {
  const s = scheduleSettings();
  const booked = bookedOf(car);
  const zones = await getZoneMap(prisma);
  const seats = seatsOf(booked);
  const fare = lockedTotal(booked);
  const mine = ctx.viewerId !== null && car.driverId === ctx.viewerId;
  const overlap = !mine && scheduleOverlaps(car.arriveBy.getTime(), ctx.held, s);
  const canAccept = car.status === "OPEN" && car.offeredAt !== null && ctx.online && !overlap;
  const riders = mine
    ? await Promise.all(
        booked.map(async (b) => ({
          firstName: firstName((await prisma.user.findUnique({ where: { id: b.riderId }, select: { name: true } }))?.name) || "Rider",
          seats: b.seats,
          pickupLabel: b.pickupLabel ?? zones.get(b.pickupZoneId)?.name ?? "Pickup",
          dropoffLabel: b.dropoffLabel ?? zones.get(b.dropoffZoneId)?.name ?? "Drop-off",
          coming: b.comingAt !== null,
        })),
      )
    : [];
  return {
    carId: car.id,
    arriveBy: car.arriveBy.toISOString(),
    leaveBy: car.leaveBy?.toISOString() ?? null,
    status: car.status === "ACCEPTED" ? "ACCEPTED" : car.status === "STARTED" ? "STARTED" : "OPEN",
    seats,
    carSeats: s.carSeats,
    farePesewas: fare,
    driverSharePesewas: splitFare(fare).driverShare,
    pickupArea: areaName(booked, "pickup", zones.get(booked[0]?.pickupZoneId ?? "")?.name),
    dropoffArea: areaName(booked, "dropoff", zones.get(booked[0]?.dropoffZoneId ?? "")?.name),
    label: scheduledOfferLabel(car.arriveBy.getTime(), seats, fare),
    mine,
    canAccept,
    note: mine || canAccept ? null : overlap ? scheduleOverlapText(s) : !ctx.online ? "Go online to accept." : null,
    riders,
    rideId: car.rideId,
  };
}

/** The driver's Schedule tab (and the board's scheduled cars): their own cars, then open offered ones by time. */
export async function driverSchedule(prisma: PrismaClient, driverUserId: string, now: Date = new Date()) {
  const [driver, held, open] = await Promise.all([
    prisma.driver.findUnique({ where: { userId: driverUserId }, select: { isOnline: true, isApproved: true, user: { select: { isReviewDemo: true } } } }),
    prisma.scheduledCar.findMany({
      where: { driverId: driverUserId, status: "ACCEPTED" },
      include: { bookings: { where: { status: "BOOKED" }, orderBy: { createdAt: "asc" } } },
      orderBy: { arriveBy: "asc" },
    }),
    prisma.scheduledCar.findMany({
      where: { status: "OPEN", offeredAt: { not: null }, arriveBy: { gt: now } },
      include: { bookings: { where: { status: "BOOKED" }, orderBy: { createdAt: "asc" } } },
      orderBy: { arriveBy: "asc" },
    }),
  ]);
  const online = Boolean(driver?.isApproved && driver.isOnline);
  // Review demo drivers never see real riders' cars.
  const openCars = driver?.user.isReviewDemo ? [] : open;
  const heldTimes = held.map((c) => c.arriveBy.getTime());
  const ctx = { viewerId: driverUserId, held: heldTimes, online, now };
  return {
    online,
    mine: await Promise.all(held.map((c) => driverCarView(prisma, c, ctx))),
    open: await Promise.all(openCars.map((c) => driverCarView(prisma, c, ctx))),
    serverTime: now.toISOString(),
  };
}

function stateOf(booking: ScheduledBooking, car: ScheduledCar): ScheduledBookingState {
  if (booking.status === "STARTED") return "DRIVER_ON_THE_WAY";
  if (booking.status === "LIVE") return "FINDING_DRIVER";
  if (car.status === "ACCEPTED") return "CAR_CONFIRMED";
  return "WAITING_FOR_RIDERS";
}

/** A rider's booking as their Home card shows it. */
export async function riderBookingView(
  prisma: PrismaClient,
  booking: ScheduledBooking & { car: ScheduledCar & { bookings: ScheduledBooking[] } },
  now: Date = new Date(),
): Promise<ScheduledBookingView> {
  const s = scheduleSettings();
  const car = booking.car;
  const inCar = car.bookings.filter((b) => b.status === "BOOKED" || b.status === "STARTED");
  const driver = car.driverId
    ? await prisma.user.findUnique({
        where: { id: car.driverId },
        select: { name: true, driver: { select: { carColor: true, carMake: true, carModel: true, plate: true, photoUrl: true } } },
      })
    : null;
  const zones = await getZoneMap(prisma);
  const window = car.leaveBy ? pickupWindowFor(car.leaveBy.getTime(), inCar.length, s) : null;
  return {
    id: booking.id,
    carId: car.id,
    arriveBy: booking.arriveBy.toISOString(),
    status: booking.status,
    state: stateOf(booking, car),
    seats: booking.seats,
    farePesewas: booking.lockedFare,
    carSeatsTaken: seatsOf(inCar),
    carSeats: s.carSeats,
    pickupLabel: booking.pickupLabel ?? zones.get(booking.pickupZoneId)?.name ?? "Your pickup",
    dropoffLabel: booking.dropoffLabel ?? zones.get(booking.dropoffZoneId)?.name ?? "Your drop-off",
    driver: driver
      ? {
          firstName: firstName(driver.name) || "Your driver",
          carColor: driver.driver?.carColor ?? null,
          carMake: driver.driver?.carMake ?? null,
          carModel: driver.driver?.carModel ?? null,
          plate: driver.driver?.plate ?? null,
          photoUrl: driver.driver?.photoUrl ?? null,
        }
      : null,
    pickupWindow: window ? { start: new Date(window.start).toISOString(), end: new Date(window.end).toISOString() } : null,
    freeCancelUntil: new Date(freeCancelUntil(booking.arriveBy.getTime(), s)).toISOString(),
    coming: booking.comingAt !== null,
    rideId: booking.rideId,
    serverTime: now.toISOString(),
  };
}

/**
 * The rider's upcoming scheduled ride, if any: a booking waiting for its car,
 * or one whose trip has started and whose pickup is still to come (the card
 * then says "Driver on the way").
 */
export async function riderUpcomingBooking(prisma: PrismaClient, riderId: string, now: Date = new Date()): Promise<ScheduledBookingView | null> {
  const booking = await prisma.scheduledBooking.findFirst({
    where: {
      riderId,
      OR: [
        { status: "BOOKED" },
        { status: "STARTED", arriveBy: { gt: new Date(now.getTime() - 60 * 60_000) } },
      ],
    },
    include: { car: { include: { bookings: true } } },
    orderBy: { arriveBy: "asc" },
  });
  if (!booking) return null;
  if (booking.status === "STARTED") {
    const seat = booking.ridePassengerId
      ? await prisma.ridePassenger.findUnique({ where: { id: booking.ridePassengerId }, select: { status: true } })
      : null;
    if (!seat || (seat.status !== "WAITING" && seat.status !== "ARRIVED")) return null;
  }
  return riderBookingView(prisma, booking, now);
}

/**
 * The schedule screen for a trip: today's and tomorrow's slots, each with
 * the seats already going the rider's way in cars with room for their party
 * ("9:00 · 2 going") and a car with a driver they can join ("Join Kofi's car").
 */
export async function scheduleOptionsFor(
  prisma: PrismaClient,
  input: { riderId: string; candidate: GroupableBooking; sharedBySeats: [number, number, number]; farTrip: boolean },
  now: Date = new Date(),
): Promise<ScheduleOptions> {
  const s = scheduleSettings();
  const [{ settings: service }, user, neighbours] = await Promise.all([
    readServiceHours(prisma),
    prisma.user.findUnique({ where: { id: input.riderId }, select: { scheduleBlockedUntil: true } }),
    zoneNeighbours(prisma),
  ]);
  const blocked = user?.scheduleBlockedUntil && user.scheduleBlockedUntil > now ? user.scheduleBlockedUntil : null;
  const slots = scheduleSlots(service, s, now.getTime());
  const dayStart = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
  const cars = await prisma.scheduledCar.findMany({
    where: { status: { in: ["OPEN", "ACCEPTED"] }, arriveBy: { gte: now, lt: new Date(dayStart + 2 * DAY_MS) } },
    include: { bookings: { where: { status: "BOOKED" } }, driver: { select: { name: true } } },
  });
  const byTime = new Map<number, typeof cars>();
  for (const c of cars) {
    // The rider's own booking doesn't count as someone going their way.
    if (c.bookings.some((b) => b.riderId === input.riderId)) continue;
    byTime.set(c.arriveBy.getTime(), [...(byTime.get(c.arriveBy.getTime()) ?? []), c]);
  }
  return {
    enabled: s.enabled,
    blockedUntil: blocked?.toISOString() ?? null,
    blockedText: blocked ? scheduleBlockedText(blocked.getTime(), s) : null,
    days: SCHEDULE_DAYS.map((day) => ({
      day,
      slots: slots[day].map((slot) => {
        const fitting = (byTime.get(slot.arriveBy) ?? []).filter((c) => bookingFitsCar(input.candidate, c.bookings.map(groupable), neighbours, s));
        // After the cutoff only a car with a driver that hasn't left yet can be joined.
        const joinable = fitting.find(
          (c) => c.status === "ACCEPTED" && (slot.bookable || (c.leaveBy !== null && c.leaveBy.getTime() > now.getTime())),
        );
        return {
          arriveBy: new Date(slot.arriveBy).toISOString(),
          bookable: slot.bookable || (joinable !== undefined && slot.arriveBy > now.getTime()),
          going: fitting.reduce((sum, c) => sum + seatsOf(c.bookings), 0),
          join: joinable
            ? { carId: joinable.id, driverFirstName: firstName(joinable.driver?.name) || "Your driver", seatsLeft: s.carSeats - seatsOf(joinable.bookings) }
            : null,
        };
      }),
    })),
    sharedBySeats: input.sharedBySeats,
    farTrip: input.farTrip,
    settings: { slotMinutes: s.slotMinutes, bookingCutoffMinutes: s.bookingCutoffMinutes, freeCancelMinutes: s.freeCancelMinutes, carSeats: s.carSeats },
    serverTime: now.toISOString(),
  };
}

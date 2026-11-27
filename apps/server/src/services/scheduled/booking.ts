import type { PrismaClient, ScheduledBooking } from "@prisma/client";
import {
  MIN_TRIP_METERS,
  SCHEDULE_EVENTS,
  SCHEDULE_SOONER_TEXT,
  bookingClosesAt,
  lateJoinFits,
  leaveByFor,
  cancelIsFree,
  chooseCar,
  firstName,
  haversineDistanceMeters,
  isValidBookingSeats,
  scheduleBlockedText,
  scheduleClock,
  seatsFilledLabel,
  slotProblem,
} from "@rida/shared";
import { emitToDrivers } from "../../realtime/rideSocket";
import { assertCanBook } from "../launch/launchSettings";
import { resolveRideEnd, type RideEndInput } from "../places/rideEnds";
import { TripTooShortError } from "../ride/createRide";
import { fareForNewBooking } from "../ride/farePricing";
import { readServiceHours } from "../service/serviceHours";
import {
  ScheduleError,
  addStrike,
  bookedOf,
  groupable,
  leaveByForCar,
  logScheduleEvent,
  seatsOf,
  tripMinutesFor,
  zoneNeighbours,
} from "./core";
import { evaluateCarNow } from "./dispatch";
import { refreshDriverLists, riderScheduleChanged, schedulePush } from "./notify";
import { scheduleSettings } from "./settings";

/** Bookings for one slot are serialised by locking that slot's cars; long enough to queue behind each other on Neon's pool. */
const TX_OPTIONS = { timeout: 20_000, maxWait: 10_000 } as const;

export interface BookScheduledInput {
  riderId: string;
  arriveBy: Date;
  pickup: RideEndInput;
  dropoff: RideEndInput;
  seats: number;
  /** The total the app showed (must be today's price for these seats). */
  shownFare?: number | null;
  pickupNote?: string | null;
  /** "Join Kofi's car": put me in that car if I still fit. */
  carId?: string | null;
}

/**
 * Books seats on a scheduled Shared ride. Refused (ScheduleError, nothing
 * kept): seats not 1–3, a slot that isn't bookable, a rider stopped by
 * strikes or with a scheduled ride already, launch mode. The pins, the
 * price (FareChangedError) and the trip length are checked as for a live
 * booking. The booking joins the best car in the slot going the same way
 * (@rida/shared chooseCar) or starts a new one, then the car is looked at
 * again at once: 3 seats are offered to drivers now.
 */
export async function bookScheduledSeat(prisma: PrismaClient, input: BookScheduledInput, now: Date = new Date()) {
  const s = scheduleSettings();
  if (!isValidBookingSeats("SHARED", input.seats)) throw new ScheduleError("INVALID_SEATS", "A Shared booking is for 1 to 3 seats.", 400);
  const { settings: service } = await readServiceHours(prisma);
  // A NEW car closes `bookingCutoffMinutes` before; joining a car that has
  // a driver stays open until it leaves (lateJoinFits, checked below).
  const lateJoin = now.getTime() > bookingClosesAt(input.arriveBy.getTime(), s);
  const problem = slotProblem(input.arriveBy.getTime(), service, s, now.getTime(), { lateJoin });
  if (problem) throw new ScheduleError(s.enabled ? "SLOT_CLOSED" : "SCHEDULING_OFF", problem, 422);

  const [user, existing] = await Promise.all([
    prisma.user.findUnique({ where: { id: input.riderId }, select: { scheduleBlockedUntil: true, isReviewDemo: true } }),
    prisma.scheduledBooking.findFirst({ where: { riderId: input.riderId, status: "BOOKED" }, select: { id: true } }),
  ]);
  if (user?.scheduleBlockedUntil && user.scheduleBlockedUntil > now) {
    throw new ScheduleError("SCHEDULE_BLOCKED", scheduleBlockedText(user.scheduleBlockedUntil.getTime(), s), 403, {
      blockedUntil: user.scheduleBlockedUntil.toISOString(),
    });
  }
  if (user?.isReviewDemo) throw new ScheduleError("SCHEDULING_OFF", "Scheduling isn't available on this account.", 422);
  if (existing) throw new ScheduleError("ALREADY_SCHEDULED", "You already have a scheduled ride. Cancel it to book another.");
  await assertCanBook(prisma, input.riderId, now);

  const [pickup, dropoff] = await Promise.all([
    resolveRideEnd(prisma, "pickup", input.pickup),
    resolveRideEnd(prisma, "dropoff", input.dropoff),
  ]);
  if (haversineDistanceMeters(pickup, dropoff) < MIN_TRIP_METERS) throw new TripTooShortError();
  const lockedFare = await fareForNewBooking(prisma, "SHARED", input.seats, pickup, dropoff, input.shownFare);
  const neighbours = await zoneNeighbours(prisma);
  const row = {
    riderId: input.riderId,
    arriveBy: input.arriveBy,
    seats: input.seats,
    lockedFare,
    pickupZoneId: pickup.zoneId,
    dropoffZoneId: dropoff.zoneId,
    pickupLat: pickup.latitude,
    pickupLng: pickup.longitude,
    pickupLabel: pickup.label,
    pickupPlaceId: pickup.placeId,
    dropoffLat: dropoff.latitude,
    dropoffLng: dropoff.longitude,
    dropoffLabel: dropoff.label,
    dropoffPlaceId: dropoff.placeId,
    pickupNote: input.pickupNote ?? null,
  };

  const { booking, car, joined } = await prisma.$transaction(async (tx) => {
    // One slot at a time: two riders booking 9:00 together can't both take the last seat.
    await tx.$queryRaw`SELECT id FROM "ScheduledCar" WHERE "arriveBy" = ${input.arriveBy} AND status IN ('OPEN', 'ACCEPTED') FOR UPDATE`;
    const again = await tx.scheduledBooking.findFirst({ where: { riderId: input.riderId, status: "BOOKED" }, select: { id: true } });
    if (again) throw new ScheduleError("ALREADY_SCHEDULED", "You already have a scheduled ride. Cancel it to book another.");
    const cars = await tx.scheduledCar.findMany({
      where: { arriveBy: input.arriveBy, status: { in: ["OPEN", "ACCEPTED"] } },
      include: { bookings: { where: { status: "BOOKED" } } },
    });
    let candidates = cars;
    if (lateJoin) {
      const fits = [];
      for (const c of cars) {
        if (c.status !== "ACCEPTED") continue;
        const trip = await tripMinutesFor(prisma, [...c.bookings, row as ScheduledBooking]);
        const withJoin = leaveByFor(c.arriveBy.getTime(), trip, c.bookings.length + 1, s);
        const car = { leaveBy: c.leaveBy?.getTime() ?? null, bookings: c.bookings.map(groupable) };
        if (lateJoinFits(car, groupable(row), neighbours, s, now.getTime(), withJoin)) fits.push(c);
      }
      candidates = fits;
    }
    const chosen = chooseCar(
      candidates.map((c) => ({ id: c.id, accepted: c.status === "ACCEPTED", createdAt: c.createdAt.getTime(), bookings: c.bookings.map(groupable), row: c })),
      groupable(row),
      neighbours,
      s,
      input.carId,
    );
    if (!chosen && lateJoin) {
      throw new ScheduleError("SLOT_CLOSED", `Booking a new car for ${scheduleClock(input.arriveBy)} has closed, and no car with a driver can fit you in. ${SCHEDULE_SOONER_TEXT}`, 422, {
        soonerLiveRide: true,
      });
    }
    const target = chosen?.row ?? (await tx.scheduledCar.create({ data: { arriveBy: input.arriveBy } }));
    const created = await tx.scheduledBooking.create({ data: { ...row, carId: target.id } });
    return { booking: created, car: target, joined: chosen !== null };
  }, TX_OPTIONS);
  await logScheduleEvent(prisma, { carId: car.id, bookingId: booking.id, kind: joined ? "JOINED" : "BOOKED", detail: `${input.seats} seat(s)` });

  await afterSeatsChanged(prisma, car.id, now, {
    driverNews: (riderName, taken, cap) => ({ title: "Rider joined", body: `${riderName} joined your ${scheduleClock(input.arriveBy)} trip · ${seatsFilledLabel(taken, cap)}.` }),
    riderId: input.riderId,
  });
  return booking;
}

/**
 * After a car's bookings changed: an accepted car gets its leave-by again and
 * the driver hears; the other riders' cards refresh; an open car is looked at
 * at once (offered, or live, or cancelled when empty).
 */
async function afterSeatsChanged(
  prisma: PrismaClient,
  carId: string,
  now: Date,
  news: { riderId: string; driverNews: (riderName: string, taken: number, capacity: number) => { title: string; body: string } },
): Promise<void> {
  const s = scheduleSettings();
  const car = await prisma.scheduledCar.findUnique({ where: { id: carId }, include: { bookings: { where: { status: "BOOKED" }, orderBy: { createdAt: "asc" } } } });
  if (!car) return;
  const booked = bookedOf(car);
  riderScheduleChanged(booked.map((b) => b.riderId).filter((id) => id !== news.riderId), { carId });
  if (car.status === "ACCEPTED" && car.driverId && booked.length > 0) {
    const leaveBy = await leaveByForCar(prisma, car.arriveBy, booked, now);
    await prisma.scheduledCar.updateMany({ where: { id: carId, status: "ACCEPTED" }, data: { leaveBy } });
    const name = firstName((await prisma.user.findUnique({ where: { id: news.riderId }, select: { name: true } }))?.name) || "A rider";
    const words = news.driverNews(name, seatsOf(booked), s.carSeats);
    schedulePush(prisma, { userIds: [car.driverId], kind: "SCHEDULE_CHANGED", id: carId, ...words, dedupeKey: `schedule-seats:${carId}:${news.riderId}:${words.title}` });
    emitToDrivers([car.driverId], SCHEDULE_EVENTS.DRIVER_CHANGED, { carId });
  }
  await evaluateCarNow(prisma, carId, now);
  refreshDriverLists(prisma, car.driverId ? [car.driverId] : []);
}

/**
 * The rider cancels their scheduled booking. Free until `freeCancelMinutes`
 * before; after that it is a strike (and may stop them scheduling). Once the
 * trip has started, cancelling is the ride screen's usual cancel.
 */
export async function cancelScheduledBooking(prisma: PrismaClient, riderId: string, bookingId: string, now: Date = new Date()) {
  const s = scheduleSettings();
  const booking = await prisma.scheduledBooking.findFirst({ where: { id: bookingId, riderId } });
  if (!booking) throw new ScheduleError("NOT_FOUND", "Scheduled ride not found.", 404);
  if (booking.status !== "BOOKED") {
    throw new ScheduleError("NOT_CANCELLABLE", booking.status === "CANCELLED" ? "This ride is already cancelled." : "Your ride has started. Cancel it from the ride screen.");
  }
  const late = !cancelIsFree(booking.arriveBy.getTime(), now.getTime(), s);
  const { count } = await prisma.scheduledBooking.updateMany({
    where: { id: bookingId, status: "BOOKED" },
    data: { status: "CANCELLED", cancelledAt: now, lateCancel: late },
  });
  if (count === 0) throw new ScheduleError("NOT_CANCELLABLE", "Your ride has started. Cancel it from the ride screen.");
  await logScheduleEvent(prisma, { carId: booking.carId, bookingId, kind: "RIDER_CANCELLED", detail: late ? "late" : "free" });
  const { blockedUntil } = late ? await addStrike(prisma, { riderId, bookingId, carId: booking.carId, kind: "LATE_CANCEL" }, now) : { blockedUntil: null };
  await afterSeatsChanged(prisma, booking.carId, now, {
    riderId,
    driverNews: (riderName, taken, cap) => ({
      title: "Rider cancelled",
      body: `${riderName} cancelled their seat on your ${scheduleClock(booking.arriveBy)} trip · ${seatsFilledLabel(taken, cap)}.`,
    }),
  });
  return { strike: late, blockedUntil };
}

/** "I'm coming" (the card or the reminder's button): the driver's Schedule tab shows it. */
export async function markComing(prisma: PrismaClient, riderId: string, bookingId: string, now: Date = new Date()): Promise<void> {
  const booking = await prisma.scheduledBooking.findFirst({ where: { id: bookingId, riderId }, include: { car: { select: { driverId: true } } } });
  if (!booking) throw new ScheduleError("NOT_FOUND", "Scheduled ride not found.", 404);
  if (booking.status !== "BOOKED" && booking.status !== "STARTED") throw new ScheduleError("NOT_ACTIVE", "This ride isn't coming up any more.");
  if (!booking.comingAt) await prisma.scheduledBooking.update({ where: { id: bookingId }, data: { comingAt: now } });
  if (booking.car.driverId) emitToDrivers([booking.car.driverId], SCHEDULE_EVENTS.DRIVER_CHANGED, { carId: booking.carId });
}

/**
 * The driver marked a rider as not at the pickup (services/ride, the
 * no-show action). On a scheduled trip that's a strike. Never throws.
 */
export async function noteScheduledNoShow(prisma: PrismaClient, ridePassengerId: string, now: Date = new Date()): Promise<void> {
  try {
    const booking = await prisma.scheduledBooking.findUnique({ where: { ridePassengerId } });
    if (!booking || booking.noShowAt) return;
    await prisma.scheduledBooking.update({ where: { id: booking.id }, data: { noShowAt: now } });
    await logScheduleEvent(prisma, { carId: booking.carId, bookingId: booking.id, kind: "NO_SHOW" });
    await addStrike(prisma, { riderId: booking.riderId, bookingId: booking.id, carId: booking.carId, kind: "NO_SHOW" }, now);
  } catch {
    // A record only: never in the way of the driver's action.
  }
}

/**
 * The rider cancelled their seat on a scheduled trip that had started (the
 * ride screen's cancel): a late cancel, so a strike. Never throws.
 */
export async function noteScheduledTripCancel(prisma: PrismaClient, rideId: string, riderId: string, now: Date = new Date()): Promise<void> {
  try {
    const booking = await prisma.scheduledBooking.findFirst({ where: { rideId, riderId, status: "STARTED" } });
    if (!booking || booking.lateCancel) return;
    await prisma.scheduledBooking.update({ where: { id: booking.id }, data: { lateCancel: true, cancelledAt: now } });
    await logScheduleEvent(prisma, { carId: booking.carId, bookingId: booking.id, kind: "RIDER_CANCELLED", detail: "trip" });
    await addStrike(prisma, { riderId, bookingId: booking.id, carId: booking.carId, kind: "LATE_CANCEL" }, now);
  } catch {
    // A record only.
  }
}

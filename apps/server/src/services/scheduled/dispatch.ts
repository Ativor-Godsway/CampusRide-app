import type { PrismaClient, ScheduledBooking } from "@prisma/client";
import {
  SCHEDULE_EVENTS,
  SCHEDULE_FINDING_NOW_TEXT,
  SCHEDULE_REMINDER_CATEGORY,
  driverReminderAt,
  firstName,
  leaveByLabel,
  openCarAction,
  pickupWindowFor,
  pickupWindowLabel,
  riderReminderAt,
  scheduleClock,
  scheduleOverlapText,
  scheduleOverlaps,
  scheduledOfferLabel,
  seatsWord,
  type ScheduleAcceptedVia,
} from "@rida/shared";
import { logger } from "../../lib/logger";
import { addRiderToRide, emitRequestsChanged, emitRideEvent, emitToDrivers } from "../../realtime/rideSocket";
import { notifyRider } from "../push/notify";
import { ActiveRideExistsError, createRide } from "../ride/createRide";
import { findActiveRideForRider } from "../ride/activeRide";
import { reofferToDriver } from "../ride/dispatch";
import { ACTIVE_DRIVER_STATUSES } from "../ride/stateMachine";
import { getDriverInfo } from "../user/driverInfo";
import {
  ScheduleError,
  UPCOMING_CAR_STATUSES,
  bookedOf,
  leaveByForCar,
  stopOrder,
  lockedTotal,
  logScheduleEvent,
  seatsOf,
  type CarWithBookings,
} from "./core";
import { liveDriverIds, refreshDriverLists, riderScheduleChanged, schedulePush } from "./notify";
import { scheduleSettings } from "./settings";
import { areaName, driverCarView } from "./views";

/**
 * The life of a scheduled car (rules: @rida/shared rides/scheduled.ts):
 * OPEN → offered to drivers (by its seats and the time) → ACCEPTED by one →
 * at leave-by STARTED as a normal Shared trip; or LIVE (its seats become
 * live requests) when no driver took it in time; or CANCELLED when empty.
 *
 * scheduleTick (every 30 s, index.ts) moves cars along; the routes call the
 * same functions at once after a booking, a cancel or a driver's answer.
 * Every change is one conditional UPDATE on the car's status, so a tick and
 * a route (or two ticks) never both act on the same car.
 */

const MINUTE_MS = 60_000;
/** A driver still on a trip at leave-by gets this long to finish it before their riders go to others. */
export const START_GRACE_MS = 5 * MINUTE_MS;

const withBooked = { bookings: { where: { status: "BOOKED" as const }, orderBy: { createdAt: "asc" as const } } };

async function loadCar(prisma: PrismaClient, carId: string): Promise<CarWithBookings | null> {
  return prisma.scheduledCar.findUnique({ where: { id: carId }, include: withBooked });
}

/** Moves every upcoming car along (offers, live requests, reminders, starts). Never throws. */
export async function scheduleTick(prisma: PrismaClient, now: Date = new Date()): Promise<void> {
  let cars: CarWithBookings[];
  try {
    cars = await prisma.scheduledCar.findMany({
      where: { status: { in: [...UPCOMING_CAR_STATUSES] }, arriveBy: { lte: new Date(now.getTime() + 2 * 24 * 60 * MINUTE_MS) } },
      include: withBooked,
      orderBy: { arriveBy: "asc" },
    });
  } catch (err) {
    logger.error("scheduled: tick failed", { err });
    return;
  }
  for (const car of cars) {
    try {
      if (car.status === "OPEN") await evaluateOpenCar(prisma, car, now);
      else await evaluateAcceptedCar(prisma, car, now);
    } catch (err) {
      logger.error("scheduled: car step failed", { err, carId: car.id });
    }
  }
}

/** A car with no driver: offer it, turn it into live requests, or cancel it (empty). */
export async function evaluateOpenCar(prisma: PrismaClient, car: CarWithBookings, now: Date = new Date()): Promise<void> {
  const booked = bookedOf(car);
  // The server was down past its time: whoever is booked still needs to go.
  if (car.arriveBy <= now) {
    if (booked.length === 0) await cancelEmptyCar(prisma, car, now);
    else await carToLive(prisma, car, "LATE", now);
    return;
  }
  const next = openCarAction({ seats: seatsOf(booked), offered: car.offeredAt !== null }, car.arriveBy.getTime(), now.getTime(), scheduleSettings());
  if (next.action === "CANCEL") await cancelEmptyCar(prisma, car, now);
  else if (next.action === "OFFER") await offerCar(prisma, car, now);
  else if (next.action === "TO_LIVE") await carToLive(prisma, car, next.reason, now);
}

/** Reloads a car and evaluates it now (after a booking, cancel or driver cancel). */
export async function evaluateCarNow(prisma: PrismaClient, carId: string, now: Date = new Date()): Promise<void> {
  const car = await loadCar(prisma, carId);
  if (!car) return;
  if (car.status === "OPEN") await evaluateOpenCar(prisma, car, now);
  else if (car.status === "ACCEPTED") await evaluateAcceptedCar(prisma, car, now);
}

async function cancelEmptyCar(prisma: PrismaClient, car: CarWithBookings, now: Date): Promise<void> {
  const { count } = await prisma.scheduledCar.updateMany({
    where: { id: car.id, status: { in: [...UPCOMING_CAR_STATUSES] } },
    data: { status: "CANCELLED", cancelledAt: now },
  });
  if (count === 0) return;
  await logScheduleEvent(prisma, { carId: car.id, kind: "CAR_CANCELLED" });
  if (car.driverId && car.status === "ACCEPTED") {
    schedulePush(prisma, {
      userIds: [car.driverId],
      kind: "SCHEDULE_CHANGED",
      id: car.id,
      title: "Scheduled trip cancelled",
      body: `Every rider cancelled your ${scheduleClock(car.arriveBy)} trip. You're free then.`,
      dedupeKey: `schedule-empty:${car.id}`,
    });
  }
  refreshDriverLists(prisma, car.driverId ? [car.driverId] : []);
}

/** Drivers a car is offered to: live and approved, minus those holding a scheduled car too close to it. */
async function offerRecipients(prisma: PrismaClient, car: CarWithBookings): Promise<string[]> {
  const s = scheduleSettings();
  const ids = await liveDriverIds(prisma);
  if (ids.length === 0) return [];
  const held = await prisma.scheduledCar.findMany({
    where: { driverId: { in: ids }, status: "ACCEPTED" },
    select: { driverId: true, arriveBy: true },
  });
  const byDriver = new Map<string, number[]>();
  for (const h of held) byDriver.set(h.driverId!, [...(byDriver.get(h.driverId!) ?? []), h.arriveBy.getTime()]);
  return ids.filter((id) => !scheduleOverlaps(car.arriveBy.getTime(), byDriver.get(id) ?? [], s));
}

/** First offer to drivers: the pop-up (socket), a push, and the board / Schedule tab. */
export async function offerCar(prisma: PrismaClient, car: CarWithBookings, now: Date = new Date()): Promise<void> {
  const { count } = await prisma.scheduledCar.updateMany({
    where: { id: car.id, status: "OPEN", offeredAt: null },
    data: { offeredAt: now },
  });
  if (count === 0) return;
  const booked = bookedOf(car);
  await logScheduleEvent(prisma, { carId: car.id, kind: "OFFERED", detail: seatsWord(seatsOf(booked)) });

  const recipients = await offerRecipients(prisma, car);
  if (recipients.length > 0) {
    const view = await driverCarView(prisma, { ...car, offeredAt: now }, { viewerId: null, held: [], online: true, now });
    emitToDrivers(recipients, SCHEDULE_EVENTS.OFFER, view);
    // A push to drivers not on a trip (a ping while driving is a distraction).
    const busy = new Set(
      (
        await prisma.ride.findMany({
          where: { driverId: { in: recipients }, status: { in: [...ACTIVE_DRIVER_STATUSES] } },
          select: { driverId: true },
        })
      ).map((r) => r.driverId),
    );
    schedulePush(prisma, {
      userIds: recipients.filter((id) => !busy.has(id)),
      kind: "SCHEDULE_OFFER",
      id: car.id,
      title: "Scheduled ride",
      body: `${scheduledOfferLabel(car.arriveBy.getTime(), seatsOf(booked), lockedTotal(booked))}. ${view.pickupArea} → ${view.dropoffArea}. Open the app to accept.`,
      dedupeKey: `schedule-offer:${car.id}`,
    });
  }
  refreshDriverLists(prisma);
}

/**
 * A driver accepts a scheduled car: it is theirs (one conditional UPDATE,
 * first wins). Refused: not online, not offered yet, taken, too close to a
 * scheduled car they already hold. Riders hear who and their pickup window.
 */
export async function acceptScheduledCar(
  prisma: PrismaClient,
  driverUserId: string,
  carId: string,
  via: ScheduleAcceptedVia | null,
  now: Date = new Date(),
): Promise<CarWithBookings> {
  const s = scheduleSettings();
  const [driver, car] = await Promise.all([
    prisma.driver.findUnique({ where: { userId: driverUserId }, select: { isApproved: true, isOnline: true, suspendedAt: true } }),
    loadCar(prisma, carId),
  ]);
  if (!car) throw new ScheduleError("NOT_FOUND", "This scheduled trip isn't available any more.", 404);
  if (car.status === "ACCEPTED" && car.driverId === driverUserId) return car;
  if (!driver?.isApproved || !driver.isOnline || driver.suspendedAt) throw new ScheduleError("NOT_ONLINE", "Go online to accept scheduled trips.", 403);
  if (car.status !== "OPEN") {
    throw new ScheduleError("SCHEDULE_TAKEN", car.status === "ACCEPTED" ? "Another driver has just taken this trip." : "This scheduled trip isn't available any more.");
  }
  if (!car.offeredAt) throw new ScheduleError("NOT_OFFERED", "This scheduled trip isn't open to drivers yet.");
  const held = await prisma.scheduledCar.findMany({ where: { driverId: driverUserId, status: "ACCEPTED" }, select: { arriveBy: true } });
  if (scheduleOverlaps(car.arriveBy.getTime(), held.map((h) => h.arriveBy.getTime()), s)) {
    throw new ScheduleError("SCHEDULE_OVERLAP", scheduleOverlapText(s));
  }
  const booked = bookedOf(car);
  const leaveBy = await leaveByForCar(prisma, car.arriveBy, booked, now);
  const { count } = await prisma.scheduledCar.updateMany({
    where: { id: carId, status: "OPEN", driverId: null },
    data: { status: "ACCEPTED", driverId: driverUserId, acceptedAt: now, acceptedVia: via, leaveBy, driverRemindedAt: null },
  });
  if (count === 0) throw new ScheduleError("SCHEDULE_TAKEN", "Another driver has just taken this trip.");
  await logScheduleEvent(prisma, { carId, kind: "ACCEPTED", detail: via ?? undefined });

  const accepted = (await loadCar(prisma, carId))!;
  const name = firstName((await prisma.user.findUnique({ where: { id: driverUserId }, select: { name: true } }))?.name) || "Your driver";
  const window = pickupWindowLabel(pickupWindowFor(leaveBy.getTime(), booked.length, s));
  schedulePush(prisma, {
    userIds: booked.map((b) => b.riderId),
    kind: "SCHEDULE_CONFIRMED",
    id: carId,
    title: "Car confirmed",
    body: `${name} will pick you up ${window} for your ${scheduleClock(car.arriveBy)} ride.`,
    dedupeKey: `schedule-confirmed:${carId}:${driverUserId}`,
  });
  riderScheduleChanged(booked.map((b) => b.riderId), { carId });
  refreshDriverLists(prisma, [driverUserId]);
  return accepted;
}

/** The driver gives an accepted car back: Open again (offered again by the rules), riders told. */
export async function driverCancelScheduledCar(prisma: PrismaClient, driverUserId: string, carId: string, now: Date = new Date()): Promise<void> {
  const car = await loadCar(prisma, carId);
  if (!car || car.driverId !== driverUserId) throw new ScheduleError("NOT_FOUND", "This scheduled trip isn't yours.", 404);
  if (car.status !== "ACCEPTED") throw new ScheduleError("NOT_CANCELLABLE", "This trip has already started. Cancel from the trip screen.");
  const { count } = await prisma.scheduledCar.updateMany({
    where: { id: carId, status: "ACCEPTED", driverId: driverUserId },
    data: { status: "OPEN", driverId: null, acceptedAt: null, acceptedVia: null, leaveBy: null, offeredAt: null, driverRemindedAt: null },
  });
  if (count === 0) throw new ScheduleError("NOT_CANCELLABLE", "This trip has already started. Cancel from the trip screen.");
  await prisma.scheduledBooking.updateMany({ where: { carId, status: "BOOKED" }, data: { remindedAt: null } });
  await logScheduleEvent(prisma, { carId, kind: "DRIVER_CANCELLED", detail: driverUserId });
  const riders = bookedOf(car).map((b) => b.riderId);
  schedulePush(prisma, {
    userIds: riders,
    kind: "SCHEDULE_UPDATE",
    id: carId,
    title: "Your driver had to cancel",
    body: `Finding you a new driver for your ${scheduleClock(car.arriveBy)} ride.`,
    dedupeKey: `schedule-driver-cancel:${carId}:${driverUserId}`,
  });
  riderScheduleChanged(riders, { carId });
  refreshDriverLists(prisma, [driverUserId]);
  await evaluateCarNow(prisma, carId, now);
}

/** An accepted car: reminders, then at leave-by the trip starts. */
export async function evaluateAcceptedCar(prisma: PrismaClient, car: CarWithBookings, now: Date = new Date()): Promise<void> {
  const s = scheduleSettings();
  const booked = bookedOf(car);
  if (booked.length === 0) return cancelEmptyCar(prisma, car, now);
  const leaveBy = car.leaveBy ?? (await leaveByForCar(prisma, car.arriveBy, booked, now));
  if (now >= leaveBy) {
    await startCar(prisma, car, now);
    return;
  }

  if (!car.driverRemindedAt && car.driverId && now.getTime() >= driverReminderAt(leaveBy.getTime(), s)) {
    const { count } = await prisma.scheduledCar.updateMany({ where: { id: car.id, driverRemindedAt: null }, data: { driverRemindedAt: now } });
    if (count > 0) {
      schedulePush(prisma, {
        userIds: [car.driverId],
        kind: "SCHEDULE_LEAVE_SOON",
        id: car.id,
        title: `${leaveByLabel(leaveBy.getTime())}`,
        body: `Your ${scheduleClock(car.arriveBy)} scheduled trip: ${seatsWord(seatsOf(booked))}, first pickup ${areaName(booked, "pickup")}.`,
        dedupeKey: `schedule-leave:${car.id}:${leaveBy.getTime()}`,
      });
    }
  }

  const window = pickupWindowFor(leaveBy.getTime(), booked.length, s);
  if (now.getTime() >= riderReminderAt(window, s)) {
    const due = booked.filter((b) => !b.remindedAt);
    if (due.length > 0) {
      await prisma.scheduledBooking.updateMany({ where: { id: { in: due.map((b) => b.id) }, remindedAt: null }, data: { remindedAt: now } });
      for (const b of due) {
        schedulePush(prisma, {
          userIds: [b.riderId],
          kind: "SCHEDULE_REMINDER",
          id: b.id,
          title: "Be ready for your ride",
          body: `Your driver picks you up ${pickupWindowLabel(window)} at ${b.pickupLabel ?? "your pickup"}. Tap “I'm coming” to let them know.`,
          dedupeKey: `schedule-remind:${b.id}`,
          categoryId: SCHEDULE_REMINDER_CATEGORY,
        });
      }
    }
  }
}

/**
 * Leave-by: the car becomes a NORMAL Shared trip — a MATCHED Ride with the
 * driver and one seat row per booking (seats and locked fares as booked),
 * tagged SCHEDULED. From here everything is the live trip's: arrivals, the
 * wait fee, pickups, no-shows, and live riders filling empty seats.
 *
 * A driver still on another trip gets START_GRACE_MS to finish; then the
 * riders become live requests. A rider who is on another ride by then is
 * taken off this car (no strike).
 */
export async function startCar(prisma: PrismaClient, car: CarWithBookings, now: Date = new Date()): Promise<string | null> {
  if (!car.driverId) return null;
  const driverId = car.driverId;
  const leaveBy = car.leaveBy ?? now;
  const busy = await prisma.ride.findFirst({ where: { driverId, status: { in: [...ACTIVE_DRIVER_STATUSES] } }, select: { id: true } });
  if (busy) {
    if (now.getTime() < leaveBy.getTime() + START_GRACE_MS) return null;
    await carToLive(prisma, car, "DRIVER_BUSY", now);
    return null;
  }

  const riding: ScheduledBooking[] = [];
  for (const b of bookedOf(car)) {
    if (await findActiveRideForRider(prisma, b.riderId)) {
      await removeBooking(prisma, b, `You're on another ride, so we took you off your ${scheduleClock(car.arriveBy)} scheduled car.`, now);
    } else riding.push(b);
  }
  if (riding.length === 0) {
    await cancelEmptyCar(prisma, { ...car, bookings: [] }, now);
    return null;
  }

  const first = riding[0]!;
  const rideId = await prisma.$transaction(async (tx) => {
    const claimed = await tx.scheduledCar.updateMany({ where: { id: car.id, status: "ACCEPTED", driverId }, data: { status: "STARTED", startedAt: now } });
    if (claimed.count === 0) return null;
    const ride = await tx.ride.create({
      data: {
        riderId: first.riderId,
        driverId,
        type: "SHARED",
        status: "MATCHED",
        matchedAt: now,
        broadcastStartedAt: now,
        booking: "SCHEDULED",
        scheduledCarId: car.id,
        acceptedVia: car.acceptedVia,
        paymentMethod: "CASH",
        pickupZoneId: first.pickupZoneId,
        dropoffZoneId: first.dropoffZoneId,
        occupancy: seatsOf(riding),
        ...pinsOf(first),
        // In pickup order (the driver's list keeps the order seats were added).
        passengers: {
          create: stopOrder(riding).pickups.map((b, i) => ({
            createdAt: new Date(now.getTime() + i),
            riderId: b.riderId,
            pickupZoneId: b.pickupZoneId,
            dropoffZoneId: b.dropoffZoneId,
            status: "WAITING" as const,
            lockedFare: b.lockedFare,
            seats: b.seats,
            ...pinsOf(b),
          })),
        },
      },
      include: { passengers: true },
    });
    await tx.scheduledCar.update({ where: { id: car.id }, data: { rideId: ride.id } });
    for (const b of riding) {
      const seat = ride.passengers.find((p) => p.riderId === b.riderId);
      await tx.scheduledBooking.update({ where: { id: b.id }, data: { status: "STARTED", rideId: ride.id, ridePassengerId: seat?.id ?? null } });
    }
    return ride.id;
  });
  if (!rideId) return null;
  await logScheduleEvent(prisma, { carId: car.id, kind: "STARTED", detail: rideId });

  // The driver: their app opens the trip (and polls for it anyway).
  emitToDrivers([driverId], SCHEDULE_EVENTS.DRIVER_CHANGED, { startedRideId: rideId });
  emitRequestsChanged(driverId);
  schedulePush(prisma, {
    userIds: [driverId],
    kind: "SCHEDULE_STARTED",
    id: rideId,
    title: `Your ${scheduleClock(car.arriveBy)} trip has started`,
    body: `Head to your first pickup: ${areaName(riding, "pickup")}.`,
    dedupeKey: `schedule-started:${car.id}`,
  });
  // The riders: the usual "Driver found! Kofi is on the way" and their ride screen.
  const riders = riding.map((b) => b.riderId);
  for (const r of riders) addRiderToRide(r, rideId);
  emitRideEvent(rideId, "ride:status", { rideId, status: "MATCHED" });
  void getDriverInfo(prisma, driverId)
    .then((info) => {
      if (info) emitRideEvent(rideId, "ride:driver_assigned", { rideId, ...info });
    })
    .catch((err) => logger.warn("scheduled: driver info failed", { err, rideId }));
  notifyRider(prisma, riders, "DRIVER_ASSIGNED", rideId, { driverUserId: driverId });
  riderScheduleChanged(riders, { carId: car.id, rideId });
  // Empty seats: live requests that fit reach the driver like any trip.
  reofferToDriver(prisma, driverId);
  refreshDriverLists(prisma, [driverId]);
  return rideId;
}

function pinsOf(b: ScheduledBooking) {
  return {
    pickupLat: b.pickupLat,
    pickupLng: b.pickupLng,
    pickupLabel: b.pickupLabel,
    pickupPlaceId: b.pickupPlaceId,
    dropoffLat: b.dropoffLat,
    dropoffLng: b.dropoffLng,
    dropoffLabel: b.dropoffLabel,
    dropoffPlaceId: b.dropoffPlaceId,
    pickupNote: b.pickupNote,
  };
}

/** Takes a booking off its car without a strike (the rider is on another ride), and tells them why. */
async function removeBooking(prisma: PrismaClient, b: ScheduledBooking, why: string, now: Date): Promise<void> {
  const { count } = await prisma.scheduledBooking.updateMany({ where: { id: b.id, status: "BOOKED" }, data: { status: "CANCELLED", cancelledAt: now } });
  if (count === 0) return;
  await logScheduleEvent(prisma, { carId: b.carId, bookingId: b.id, kind: "REMOVED" });
  schedulePush(prisma, { userIds: [b.riderId], kind: "SCHEDULE_UPDATE", id: b.id, title: "Scheduled ride removed", body: why, dedupeKey: `schedule-removed:${b.id}` });
  riderScheduleChanged([b.riderId], { carId: b.carId });
}

/** Why a car became live requests, as its riders hear it. */
const LIVE_WORDS: Record<string, string> = {
  ONE_SEAT: "No one else booked your time, so we're asking drivers nearby now.",
  NO_DRIVER: "No driver took your scheduled car, so we're asking drivers nearby now.",
  DRIVER_BUSY: "Your driver is still on another trip, so we're asking drivers nearby now.",
  LATE: "We're asking drivers nearby now.",
};

/**
 * The car's seats become normal live requests (one per booking, its seats
 * and locked fare, Ride.booking SCHEDULED_TO_LIVE): the usual search, pop-ups
 * and board. Each rider is told "We're finding you a driver now".
 */
export async function carToLive(prisma: PrismaClient, car: CarWithBookings, reason: string, now: Date = new Date()): Promise<void> {
  const { count } = await prisma.scheduledCar.updateMany({
    where: { id: car.id, status: { in: [...UPCOMING_CAR_STATUSES] } },
    data: { status: "LIVE", liveAt: now, liveReason: reason },
  });
  if (count === 0) return;
  await logScheduleEvent(prisma, { carId: car.id, kind: "CAR_TO_LIVE", detail: reason });

  for (const b of bookedOf(car)) {
    try {
      const ride = await liveRequestFor(prisma, b, car.id);
      await prisma.scheduledBooking.update({ where: { id: b.id }, data: { status: "LIVE", rideId: ride.id, liveAt: now } });
      await logScheduleEvent(prisma, { carId: car.id, bookingId: b.id, kind: "TO_LIVE", detail: reason });
      schedulePush(prisma, {
        userIds: [b.riderId],
        kind: "SCHEDULE_LIVE",
        id: ride.id,
        title: SCHEDULE_FINDING_NOW_TEXT,
        body: LIVE_WORDS[reason] ?? LIVE_WORDS.LATE!,
        dedupeKey: `schedule-live:${b.id}`,
      });
      riderScheduleChanged([b.riderId], { carId: car.id, rideId: ride.id });
    } catch (err) {
      if (!(err instanceof ActiveRideExistsError)) logger.error("scheduled: live request failed", { err, bookingId: b.id });
      await removeBooking(
        prisma,
        b,
        err instanceof ActiveRideExistsError
          ? `You're on another ride, so we took you off your ${scheduleClock(car.arriveBy)} scheduled car.`
          : `We couldn't book your ${scheduleClock(car.arriveBy)} ride. Please request a ride now.`,
        now,
      );
    }
  }
  if (car.status === "ACCEPTED" && car.driverId) {
    schedulePush(prisma, {
      userIds: [car.driverId],
      kind: "SCHEDULE_CHANGED",
      id: car.id,
      title: "Scheduled riders passed on",
      body: `You were still on a trip, so your ${scheduleClock(car.arriveBy)} riders were offered to other drivers.`,
      dedupeKey: `schedule-passed:${car.id}`,
    });
  }
  refreshDriverLists(prisma, car.driverId ? [car.driverId] : []);
}

/** A live request for one scheduled booking (its pins; if they no longer resolve, its zones). */
async function liveRequestFor(prisma: PrismaClient, b: ScheduledBooking, carId: string) {
  const base = {
    riderId: b.riderId,
    type: "SHARED" as const,
    seats: b.seats,
    pickupNote: b.pickupNote,
    paymentMethod: "CASH" as const,
    fromSchedule: { lockedFare: b.lockedFare, scheduledCarId: carId },
  };
  const end = (lat: number | null, lng: number | null, placeId: string | null) =>
    lat != null && lng != null ? { latitude: lat, longitude: lng, ...(placeId ? { placeId } : {}) } : undefined;
  const pickup = end(b.pickupLat, b.pickupLng, b.pickupPlaceId);
  const dropoff = end(b.dropoffLat, b.dropoffLng, b.dropoffPlaceId);
  try {
    return await createRide(prisma, { ...base, pickup, dropoff, pickupZoneId: b.pickupZoneId, dropoffZoneId: b.dropoffZoneId });
  } catch (err) {
    if (err instanceof ActiveRideExistsError || (!pickup && !dropoff)) throw err;
    // A place gone since booking: the zones still say where.
    return createRide(prisma, { ...base, pickupZoneId: b.pickupZoneId, dropoffZoneId: b.dropoffZoneId });
  }
}

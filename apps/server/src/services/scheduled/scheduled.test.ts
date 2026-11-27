import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Zone } from "@prisma/client";

// Live requests made from scheduled seats would really be broadcast; the
// tests only need the rows (and no stray work after the suite ends).
vi.mock("../ride/dispatch", async (original) => ({
  ...(await original<typeof import("../ride/dispatch")>()),
  broadcastRide: vi.fn(async () => []),
  reofferToDriver: vi.fn(),
}));

import { prisma } from "../../db/prisma";
import { createTestDriver, createTestUser, getThreeTestZones } from "../ride/testFixtures";
import { setScheduleSettingsForTests } from "./settings";
import { bookScheduledSeat, cancelScheduledBooking, noteScheduledNoShow } from "./booking";
import { acceptScheduledCar, driverCancelScheduledCar, evaluateCarNow, scheduleTick } from "./dispatch";
import { ScheduleError } from "./core";
import { driverSchedule, riderUpcomingBooking, scheduleOptionsFor } from "./views";
import { groupable } from "./core";
import { planStops } from "@rida/shared";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
// Far in the future, one day per test, so tests never meet each other's cars.
const BASE_DAY = Date.UTC(2031, 0, 6);
let dayIndex = 0;

let zones: { pickup: Zone; adjacent: Zone; distant: Zone };
const userIds: string[] = [];

async function rider() {
  const u = await createTestUser("RIDER");
  userIds.push(u.id);
  return u;
}

async function driver() {
  const { user } = await createTestDriver({ isOnline: true, isApproved: true, currentZoneId: zones.pickup.id });
  userIds.push(user.id);
  return user;
}

const pin = (z: Zone) => ({ latitude: z.latitude, longitude: z.longitude });

/** A fresh day: `slot(h, m)` is an arrive-by time on it, `at(h, m)` a clock time. */
function newDay() {
  const day = BASE_DAY + dayIndex++ * DAY;
  const at = (h: number, m = 0) => new Date(day + (h * 60 + m) * MIN);
  return { at, slot: at };
}

/** Two drop-offs at opposite ends of campus (inside the service area). */
const NORTH = { latitude: 5.664, longitude: -0.183 };
const SOUTH = { latitude: 5.643, longitude: -0.19 };

async function book(
  riderId: string,
  arriveBy: Date,
  now: Date,
  opts: { seats?: number; to?: Zone; toPin?: { latitude: number; longitude: number }; carId?: string } = {},
) {
  return bookScheduledSeat(
    prisma,
    { riderId, arriveBy, pickup: pin(zones.pickup), dropoff: opts.toPin ?? pin(opts.to ?? zones.adjacent), seats: opts.seats ?? 1, carId: opts.carId ?? null },
    now,
  );
}

const car = (id: string) => prisma.scheduledCar.findUniqueOrThrow({ where: { id }, include: { bookings: true } });

beforeAll(async () => {
  zones = await getThreeTestZones();
});

beforeEach(() => {
  setScheduleSettingsForTests();
});

afterAll(async () => {
  const rides = await prisma.ride.findMany({ where: { OR: [{ riderId: { in: userIds } }, { driverId: { in: userIds } }] }, select: { id: true } });
  await prisma.scheduledBooking.deleteMany({ where: { riderId: { in: userIds } } });
  await prisma.scheduledCar.deleteMany({ where: { arriveBy: { gte: new Date(BASE_DAY), lt: new Date(BASE_DAY + 400 * DAY) } } });
  await prisma.scheduleStrike.deleteMany({ where: { riderId: { in: userIds } } });
  await prisma.ride.deleteMany({ where: { id: { in: rides.map((r) => r.id) } } });
  await prisma.driver.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
});

describe("booking and grouping", () => {
  it("riders going the same way in one slot share a car; the opposite direction from the same pickup gets its own", async () => {
    const { at, slot } = newDay();
    const [a, b, c] = [await rider(), await rider(), await rider()];
    const first = await book(a.id, slot(10), at(6), { toPin: NORTH });
    const second = await book(b.id, slot(10), at(6), { toPin: NORTH });
    const third = await book(c.id, slot(10), at(6), { toPin: SOUTH });
    expect(second.carId).toBe(first.carId);
    expect(third.carId).not.toBe(first.carId);
  });

  it("a car holds at most 4 seats", async () => {
    const { at, slot } = newDay();
    const [a, b] = [await rider(), await rider()];
    const three = await book(a.id, slot(10), at(6), { seats: 3 });
    const two = await book(b.id, slot(10), at(6), { seats: 2 });
    expect(two.carId).not.toBe(three.carId);
  });

  it("prices: the same as now (GH₵7 / 14 / 18 for 1 / 2 / 3 seats), locked on the booking", async () => {
    const { at, slot } = newDay();
    const fares = [];
    for (const seats of [1, 2, 3]) {
      const r = await rider();
      fares.push((await book(r.id, slot(9, seats * 10), at(6), { seats })).lockedFare);
    }
    expect(fares).toEqual([700, 1400, 1800]);
  });

  it("booking closes 20 minutes before; one scheduled ride at a time", async () => {
    const { at, slot } = newDay();
    const a = await rider();
    await expect(book(a.id, slot(10), at(9, 41))).rejects.toMatchObject({ code: "SLOT_CLOSED" });
    // (At 9:40 exactly a 1-seat car would turn live at once: 20 minutes to go.)
    await book(a.id, slot(10), at(9, 39));
    await expect(book(a.id, slot(11), at(9, 39))).rejects.toMatchObject({ code: "ALREADY_SCHEDULED" });
  });
});

describe("dispatch", () => {
  it("3+ seats: offered to drivers at once", async () => {
    const { at, slot } = newDay();
    const b = await book((await rider()).id, slot(12), at(6), { seats: 3 });
    expect((await car(b.carId)).offeredAt).not.toBeNull();
  });

  it("exactly 2 seats: offered 30 minutes before", async () => {
    const { at, slot } = newDay();
    const b = await book((await rider()).id, slot(12), at(6), { seats: 2 });
    expect((await car(b.carId)).offeredAt).toBeNull();
    await evaluateCarNow(prisma, b.carId, at(11, 29));
    expect((await car(b.carId)).offeredAt).toBeNull();
    await evaluateCarNow(prisma, b.carId, at(11, 30));
    expect((await car(b.carId)).offeredAt).not.toBeNull();
  });

  it("1 seat: becomes a normal live request 20 minutes before, with its seats and locked fare", async () => {
    const { at, slot } = newDay();
    const r = await rider();
    const b = await book(r.id, slot(12), at(6));
    await evaluateCarNow(prisma, b.carId, at(11, 35));
    expect((await car(b.carId)).status).toBe("OPEN");
    await evaluateCarNow(prisma, b.carId, at(11, 40));
    const after = await car(b.carId);
    expect(after.status).toBe("LIVE");
    expect(after.liveReason).toBe("ONE_SEAT");
    const booking = after.bookings[0]!;
    expect(booking.status).toBe("LIVE");
    const ride = await prisma.ride.findUniqueOrThrow({ where: { id: booking.rideId! }, include: { passengers: true } });
    expect(ride).toMatchObject({ status: "REQUESTED", type: "SHARED", booking: "SCHEDULED_TO_LIVE", scheduledCarId: b.carId, riderId: r.id });
    expect(ride.passengers[0]).toMatchObject({ lockedFare: 700, seats: 1 });
  });

  it("no driver by 25 minutes before: every booking becomes a live request", async () => {
    const { at, slot } = newDay();
    const a = await book((await rider()).id, slot(12), at(6));
    await book((await rider()).id, slot(12), at(6), { seats: 2 });
    await scheduleTick(prisma, at(11, 30));
    expect((await car(a.carId)).offeredAt).not.toBeNull();
    await evaluateCarNow(prisma, a.carId, at(11, 35));
    const after = await car(a.carId);
    expect(after).toMatchObject({ status: "LIVE", liveReason: "NO_DRIVER" });
    expect(after.bookings.every((x) => x.status === "LIVE" && x.rideId)).toBe(true);
  });
});

describe("drivers", () => {
  it("accept locks the car; matching bookings join it up to 4 seats; riders see the driver and window", async () => {
    const { at, slot } = newDay();
    const d = await driver();
    const first = await book((await rider()).id, slot(10), at(6), { seats: 3 });
    const accepted = await acceptScheduledCar(prisma, d.id, first.carId, "SCHEDULE", at(6, 5));
    expect(accepted).toMatchObject({ status: "ACCEPTED", driverId: d.id, acceptedVia: "SCHEDULE" });
    expect(accepted.leaveBy!.getTime()).toBeLessThan(slot(10).getTime());

    const other = await rider();
    const options = await scheduleOptionsFor(
      prisma,
      {
        riderId: other.id,
        candidate: { pickup: { zoneId: zones.pickup.id }, dropoff: { zoneId: zones.adjacent.id }, seats: 1 },
        sharedBySeats: [700, 1400, 1800],
        farTrip: false,
      },
      at(6, 10),
    );
    const tile = options.days.flatMap((d) => d.slots).find((s) => s.arriveBy === slot(10).toISOString())!;
    expect(tile.join).toMatchObject({ carId: first.carId, seatsLeft: 1 });
    expect(tile.going).toBe(3);

    const joined = await book(other.id, slot(10), at(6, 10), { carId: first.carId });
    expect(joined.carId).toBe(first.carId);
    const full = await book((await rider()).id, slot(10), at(6, 10));
    expect(full.carId).not.toBe(first.carId);

    const view = await riderUpcomingBooking(prisma, other.id, at(6, 11));
    expect(view).toMatchObject({ state: "CAR_CONFIRMED", carSeatsTaken: 4 });
    expect(view!.driver?.firstName).toBeTruthy();
    expect(view!.pickupWindow).not.toBeNull();
  });

  it("joining a car with a driver stays open after the cutoff, until it leaves; a new car doesn't", async () => {
    const { at, slot } = newDay();
    const d = await driver();
    const first = await book((await rider()).id, slot(10), at(6), { seats: 3 });
    const accepted = await acceptScheduledCar(prisma, d.id, first.carId, "POPUP", at(6, 5));
    const late = at(9, 45); // booking for new cars closed at 9:40
    expect(late.getTime()).toBeLessThan(accepted.leaveBy!.getTime());
    const joined = await book((await rider()).id, slot(10), late);
    expect(joined.carId).toBe(first.carId);
    await expect(book((await rider()).id, slot(10), late)).rejects.toMatchObject({ code: "SLOT_CLOSED", extra: { soonerLiveRide: true } });
  });

  it("a driver can't hold two scheduled cars less than 25 minutes apart", async () => {
    const { at, slot } = newDay();
    const d = await driver();
    const nine = await book((await rider()).id, slot(9), at(6), { seats: 3 });
    const nineTwenty = await book((await rider()).id, slot(9, 20), at(6), { seats: 3 });
    const nineThirty = await book((await rider()).id, slot(9, 30), at(6), { seats: 3, toPin: SOUTH });
    await acceptScheduledCar(prisma, d.id, nine.carId, "BOARD", at(6, 1));
    await expect(acceptScheduledCar(prisma, d.id, nineTwenty.carId, "BOARD", at(6, 2))).rejects.toMatchObject({ code: "SCHEDULE_OVERLAP" });
    await expect(acceptScheduledCar(prisma, d.id, nineThirty.carId, "BOARD", at(6, 2))).resolves.toMatchObject({ status: "ACCEPTED" });
  });

  it("another driver can't take an accepted car", async () => {
    const { at, slot } = newDay();
    const [d1, d2] = [await driver(), await driver()];
    const b = await book((await rider()).id, slot(11), at(6), { seats: 3 });
    await acceptScheduledCar(prisma, d1.id, b.carId, null, at(6, 1));
    await expect(acceptScheduledCar(prisma, d2.id, b.carId, null, at(6, 2))).rejects.toBeInstanceOf(ScheduleError);
    expect((await car(b.carId)).driverId).toBe(d1.id);
  });

  it("a driver cancelling puts the car back to Open (and offers it again)", async () => {
    const { at, slot } = newDay();
    const d = await driver();
    const b = await book((await rider()).id, slot(11), at(6), { seats: 3 });
    await acceptScheduledCar(prisma, d.id, b.carId, null, at(6, 1));
    await driverCancelScheduledCar(prisma, d.id, b.carId, at(7));
    const after = await car(b.carId);
    expect(after).toMatchObject({ status: "OPEN", driverId: null, leaveBy: null });
    expect(after.offeredAt).not.toBeNull();
  });

  it("at leave-by the car becomes a normal MATCHED Shared trip with every booking's seats and fare", async () => {
    const { at, slot } = newDay();
    const d = await driver();
    const [a, b] = [await rider(), await rider()];
    const first = await book(a.id, slot(10), at(6), { seats: 2 });
    await book(b.id, slot(10), at(6), { seats: 1 });
    await evaluateCarNow(prisma, first.carId, at(9, 30));
    const accepted = await acceptScheduledCar(prisma, d.id, first.carId, "POPUP", at(9, 31));
    await scheduleTick(prisma, new Date(accepted.leaveBy!.getTime() - MIN));
    expect((await car(first.carId)).status).toBe("ACCEPTED");
    await scheduleTick(prisma, accepted.leaveBy!);
    const started = await car(first.carId);
    expect(started.status).toBe("STARTED");
    const ride = await prisma.ride.findUniqueOrThrow({ where: { id: started.rideId! }, include: { passengers: true } });
    expect(ride).toMatchObject({ status: "MATCHED", type: "SHARED", driverId: d.id, booking: "SCHEDULED", occupancy: 3 });
    expect(ride.passengers.map((p) => [p.riderId, p.seats, p.lockedFare, p.status]).sort()).toEqual(
      [
        [a.id, 2, 1400, "WAITING"],
        [b.id, 1, 700, "WAITING"],
      ].sort(),
    );
    expect(started.bookings.every((x) => x.status === "STARTED" && x.ridePassengerId)).toBe(true);
    // The rider's card now says the driver is on the way.
    expect(await riderUpcomingBooking(prisma, b.id, accepted.leaveBy!)).toMatchObject({ state: "DRIVER_ON_THE_WAY", rideId: ride.id });
  });
});

describe("stop order", () => {
  it("riders are listed (driver) and seated (trip) in pickup order, each with their drop-off and phone", async () => {
    const { at, slot } = newDay();
    const d = await driver();
    const [a, b] = [await rider(), await rider()];
    // a books from the pickup zone; b from the adjacent zone; both towards the north end.
    const first = await book(a.id, slot(10), at(6), { seats: 2, toPin: NORTH });
    await bookScheduledSeat(prisma, { riderId: b.id, arriveBy: slot(10), pickup: pin(zones.adjacent), dropoff: { latitude: 5.6635, longitude: -0.1835 }, seats: 1 }, at(6));
    expect((await car(first.carId)).bookings).toHaveLength(2);
    await evaluateCarNow(prisma, first.carId, at(9, 30));
    const accepted = await acceptScheduledCar(prisma, d.id, first.carId, "SCHEDULE", at(9, 31));

    const tab = await driverSchedule(prisma, d.id, at(9, 32));
    const mine = tab.mine.find((c) => c.carId === first.carId)!;
    const bookings = (await car(first.carId)).bookings;
    const plan = planStops(bookings.map(groupable))!;
    const expectedFirst = bookings[plan.pickupOrder[0]!]!;
    expect(mine.riders).toHaveLength(2);
    expect(mine.riders[0]!.seats).toBe(expectedFirst.seats);
    expect(mine.riders.every((r) => r.phone?.startsWith("+233") && r.dropoffLabel)).toBe(true);
    expect(mine.route).toMatchObject({ pickups: expect.any(Number), meters: expect.any(Number) });

    await scheduleTick(prisma, accepted.leaveBy!);
    const started = await car(first.carId);
    const seats = await prisma.ridePassenger.findMany({ where: { rideId: started.rideId! }, orderBy: { createdAt: "asc" } });
    expect(seats.map((p) => p.riderId)).toEqual(plan.pickupOrder.map((i) => bookings[i]!.riderId));
  });
});

describe("rider cancels, no-shows and strikes", () => {
  it("free until 30 minutes before; later is a strike; 2 strikes stop scheduling for 7 days", async () => {
    const { at, slot } = newDay();
    const r = await rider();
    const free = await book(r.id, slot(10), at(6));
    expect(await cancelScheduledBooking(prisma, r.id, free.id, at(9, 30))).toMatchObject({ strike: false, blockedUntil: null });

    const late1 = await book(r.id, slot(11), at(9, 31));
    expect(await cancelScheduledBooking(prisma, r.id, late1.id, at(10, 31))).toMatchObject({ strike: true, blockedUntil: null });
    const late2 = await book(r.id, slot(12), at(10, 32));
    const second = await cancelScheduledBooking(prisma, r.id, late2.id, at(11, 40));
    expect(second.strike).toBe(true);
    expect(second.blockedUntil?.getTime()).toBe(at(11, 40).getTime() + 7 * DAY);
    await expect(book(r.id, slot(15), at(11, 41))).rejects.toMatchObject({ code: "SCHEDULE_BLOCKED" });
  });

  it("an emptied car is cancelled", async () => {
    const { at, slot } = newDay();
    const r = await rider();
    const b = await book(r.id, slot(10), at(6));
    await cancelScheduledBooking(prisma, r.id, b.id, at(7));
    expect((await car(b.carId)).status).toBe("CANCELLED");
  });

  it("a no-show on the scheduled trip is a strike", async () => {
    const { at, slot } = newDay();
    const d = await driver();
    const r = await rider();
    const b = await book(r.id, slot(10), at(6), { seats: 3 });
    const accepted = await acceptScheduledCar(prisma, d.id, b.carId, null, at(6, 1));
    await scheduleTick(prisma, accepted.leaveBy!);
    const booking = await prisma.scheduledBooking.findUniqueOrThrow({ where: { id: b.id } });
    await noteScheduledNoShow(prisma, booking.ridePassengerId!, at(9, 55));
    expect(await prisma.scheduleStrike.count({ where: { riderId: r.id, kind: "NO_SHOW" } })).toBe(1);
    // Only once.
    await noteScheduledNoShow(prisma, booking.ridePassengerId!, at(9, 56));
    expect(await prisma.scheduleStrike.count({ where: { riderId: r.id } })).toBe(1);
  });
});

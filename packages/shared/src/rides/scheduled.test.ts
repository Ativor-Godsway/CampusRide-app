import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCHEDULE_SETTINGS as S,
  bookingFitsCar,
  cancelIsFree,
  chooseCar,
  dropoffsCompatible,
  goingLabel,
  joinCarLabel,
  leaveByFor,
  neighboursFrom,
  offerOpensAt,
  openCarAction,
  pickupWindowFor,
  pickupWindowLabel,
  pickupsClose,
  readScheduleSettings,
  reserveButtonLabel,
  scheduleBlockedText,
  scheduleCancelText,
  scheduleClock,
  scheduleDayOf,
  scheduleOverlaps,
  scheduleSettingsProblem,
  scheduleSlots,
  scheduledOfferLabel,
  seatsFilledLabel,
  slotProblem,
  slotsForDay,
  strikesBlock,
  strikesCountFrom,
  type GroupableBooking,
  SCHEDULE_INTRO_STEPS,
  drivingMinutes,
  extraRouteMeters,
  pickableSlots,
  planStops,
  scheduleHourLabel,
  scheduleTime,
  scheduledConfirmLine,
  sharedDropoff,
  slotTileLine,
  firstChoice,
  joinChips,
  lateJoinFits,
  needsLiveRideInstead,
  scheduleHours,
  shouldShowScheduleIntro,
  slotsInHour,
} from "./scheduled";
import { DEFAULT_SERVICE_SETTINGS, type ServiceSettings } from "../service/serviceHours";
import { DEFAULT_FARE_PRICES, sharedFare } from "../pricing/farTrips";
import { haversineDistanceMeters } from "../geo/distance";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
// Friday 27 Nov 2026, 00:00 Accra (= UTC).
const DAY0 = Date.UTC(2026, 10, 27);
const at = (h: number, m = 0, day = DAY0) => day + (h * 60 + m) * MIN;

describe("slots", () => {
  it("every 10 minutes from opening to closing (08:00–17:00 → 8:00 AM … 5:00 PM)", () => {
    const slots = slotsForDay(DAY0, DEFAULT_SERVICE_SETTINGS, S, at(6));
    expect(slots).toHaveLength(55);
    expect(scheduleClock(slots[0]!.arriveBy)).toBe("8:00 AM");
    expect(scheduleClock(slots[slots.length - 1]!.arriveBy)).toBe("5:00 PM");
    expect(slots.every((s) => s.bookable)).toBe(true);
  });

  it("booking closes 20 minutes before the arrive-by time", () => {
    const slots = slotsForDay(DAY0, DEFAULT_SERVICE_SETTINGS, S, at(9, 10));
    const byClock = new Map(slots.map((s) => [scheduleClock(s.arriveBy), s]));
    expect(byClock.get("9:20 AM")!.bookable).toBe(false);
    expect(byClock.get("9:30 AM")!.bookable).toBe(true); // closes 9:10 exactly: still open
    expect(byClock.get("9:30 AM")!.closesAt).toBe(at(9, 10));
    expect(slotProblem(at(9, 30), DEFAULT_SERVICE_SETTINGS, S, at(9, 10, DAY0) + 1)).toMatch(/has closed/);
  });

  it("today only, on the slot grid, while open (the closing time is the last arrive-by)", () => {
    const now = at(7);
    expect(slotProblem(at(9), DEFAULT_SERVICE_SETTINGS, S, now)).toBeNull();
    expect(slotProblem(at(17), DEFAULT_SERVICE_SETTINGS, S, now)).toBeNull();
    expect(slotProblem(at(17, 10), DEFAULT_SERVICE_SETTINGS, S, now)).toMatch(/isn't open/);
    expect(slotProblem(at(7, 50), DEFAULT_SERVICE_SETTINGS, S, now)).toMatch(/isn't open/);
    expect(slotProblem(at(9, 0, DAY0 + DAY), DEFAULT_SERVICE_SETTINGS, S, now)).toMatch(/later today/);
    expect(slotProblem(at(9, 5), DEFAULT_SERVICE_SETTINGS, S, now)).toMatch(/times shown/);
    expect(slotProblem(at(18), DEFAULT_SERVICE_SETTINGS, S, now)).toMatch(/isn't open/);
    expect(slotProblem(at(9), DEFAULT_SERVICE_SETTINGS, { ...S, enabled: false }, now)).toMatch(/isn't available/);
  });

  it("follows the weekly schedule and an admin override", () => {
    const closedSunday: ServiceSettings = {
      ...DEFAULT_SERVICE_SETTINGS,
      weekly: DEFAULT_SERVICE_SETTINGS.weekly.map((d, i) => (i === 6 ? null : d)),
    };
    // DAY0 is a Friday; tomorrow (Saturday, index 6) is closed all day.
    // DAY0 + 1 is the closed Saturday: nothing to schedule that day.
    expect(scheduleSlots(closedSunday, S, at(7, 0, DAY0 + DAY)).today).toHaveLength(0);
    expect(scheduleSlots(closedSunday, S, at(7)).today).toHaveLength(55);
    // Admin hours 09:00–13:00: 9 AM to 1 PM, nothing outside.
    const short: ServiceSettings = { ...DEFAULT_SERVICE_SETTINGS, weekly: DEFAULT_SERVICE_SETTINGS.weekly.map(() => ({ open: "09:00", close: "13:00" })) };
    const t = scheduleSlots(short, S, at(7)).today;
    expect([scheduleClock(t[0]!.arriveBy), scheduleClock(t[t.length - 1]!.arriveBy)]).toEqual(["9:00 AM", "1:00 PM"]);
    const openNow: ServiceSettings = { ...DEFAULT_SERVICE_SETTINGS, override: { mode: "OPEN", until: null } };
    expect(slotsForDay(DAY0, openNow, S, at(0))).toHaveLength(144);
  });

  it("day words", () => {
    expect(scheduleDayOf(at(9), at(7))).toBe("today");
    expect(scheduleDayOf(at(9, 0, DAY0 + DAY), at(23))).toBe("tomorrow");
    expect(scheduleDayOf(at(9, 0, DAY0 - DAY), at(7))).toBeNull();
  });
});

describe("grouping", () => {
  const neighbours = neighboursFrom([{ zoneId: "A", adjacentZoneId: "B" }]);
  const book = (pickup: string, dropoff: string, seats = 1, lat?: number): GroupableBooking => ({
    pickup: { zoneId: pickup, latitude: lat ?? null, longitude: lat === undefined ? null : -0.186 },
    dropoff: { zoneId: dropoff },
    seats,
  });

  it("pickups: same zone, a neighbour (either way round), or within 600 m", () => {
    expect(pickupsClose(book("A", "X").pickup, book("A", "X").pickup, neighbours, 600)).toBe(true);
    expect(pickupsClose(book("B", "X").pickup, book("A", "X").pickup, neighbours, 600)).toBe(true);
    // 0.004° of latitude ≈ 445 m.
    expect(pickupsClose(book("C", "X", 1, 5.65).pickup, book("D", "X", 1, 5.654).pickup, neighbours, 600)).toBe(true);
    expect(pickupsClose(book("C", "X", 1, 5.65).pickup, book("D", "X", 1, 5.66).pickup, neighbours, 600)).toBe(false);
    expect(pickupsClose(book("C", "X").pickup, book("D", "X").pickup, neighbours, 600)).toBe(false);
  });

  it("drop-offs: the same or a neighbour zone", () => {
    expect(dropoffsCompatible({ zoneId: "A" }, { zoneId: "B" }, neighbours)).toBe(true);
    expect(dropoffsCompatible({ zoneId: "A" }, { zoneId: "C" }, neighbours)).toBe(false);
  });

  it("a car takes at most 4 seats, and the newcomer must suit everyone in it", () => {
    expect(bookingFitsCar(book("A", "X", 1), [book("A", "X", 3)], neighbours, S)).toBe(true);
    expect(bookingFitsCar(book("A", "X", 2), [book("A", "X", 3)], neighbours, S)).toBe(false);
    expect(bookingFitsCar(book("A", "X"), [book("A", "X"), book("A", "Y")], neighbours, S)).toBe(false);
  });

  it("prefers the rider's chosen car, then a car with a driver, the fullest, the oldest", () => {
    const car = (id: string, accepted: boolean, seats: number, createdAt: number) => ({
      id,
      accepted,
      createdAt,
      bookings: [book("A", "X", seats)],
    });
    const cars = [car("old", false, 1, 1), car("full", false, 2, 2), car("driver", true, 1, 3), car("tooFull", true, 3, 0)];
    expect(chooseCar(cars, book("A", "X", 2), neighbours, S)?.id).toBe("driver");
    expect(chooseCar(cars, book("A", "X", 2), neighbours, S, "old")?.id).toBe("old");
    expect(chooseCar(cars, book("A", "X", 2), neighbours, S, "tooFull")?.id).toBe("driver");
    expect(chooseCar(cars.filter((c) => !c.accepted), book("A", "X", 1), neighbours, S)?.id).toBe("full");
    expect(chooseCar(cars, book("Q", "Z"), neighbours, S)).toBeNull();
  });
});

describe("dispatch of a car no driver has", () => {
  const arriveBy = at(9, 30);
  const act = (seats: number, minutesBefore: number, offered = false) =>
    openCarAction({ seats, offered }, arriveBy, arriveBy - minutesBefore * MIN, S);

  it("3+ seats: offered at once", () => {
    expect(act(3, 600)).toEqual({ action: "OFFER" });
    expect(act(4, 120)).toEqual({ action: "OFFER" });
    expect(act(3, 120, true)).toEqual({ action: "WAIT" });
    expect(offerOpensAt(3, arriveBy, S)).toBe(Number.NEGATIVE_INFINITY);
  });

  it("exactly 2 seats: offered 30 minutes before", () => {
    expect(act(2, 31)).toEqual({ action: "WAIT" });
    expect(act(2, 30)).toEqual({ action: "OFFER" });
    expect(offerOpensAt(2, arriveBy, S)).toBe(arriveBy - 30 * MIN);
  });

  it("1 seat: never offered; a live request 20 minutes before", () => {
    expect(act(1, 30)).toEqual({ action: "WAIT" });
    expect(act(1, 21)).toEqual({ action: "WAIT" });
    expect(act(1, 20)).toEqual({ action: "TO_LIVE", reason: "ONE_SEAT" });
    expect(offerOpensAt(1, arriveBy, S)).toBeNull();
  });

  it("no driver by 25 minutes before: live requests", () => {
    expect(act(2, 26, true)).toEqual({ action: "WAIT" });
    expect(act(2, 25, true)).toEqual({ action: "TO_LIVE", reason: "NO_DRIVER" });
    expect(act(4, 25, true)).toEqual({ action: "TO_LIVE", reason: "NO_DRIVER" });
  });

  it("empty: cancelled", () => {
    expect(act(0, 60)).toEqual({ action: "CANCEL" });
  });
});

describe("times", () => {
  it("leave by = arrive-by − trip − 3 min a pickup − 5 spare, never before now", () => {
    expect(scheduleClock(leaveByFor(at(9), 8, 3, S))).toBe("8:38 AM");
    expect(leaveByFor(at(9), 8, 3, S, at(8, 50))).toBe(at(8, 50));
  });

  it("pickup window from leave-by, 7 minutes (longer with many pickups)", () => {
    const w = pickupWindowFor(at(8, 38), 2, S);
    expect(pickupWindowLabel(w)).toBe("8:38\u20138:45 AM");
    expect(pickupWindowLabel({ start: at(11, 55), end: at(12, 2) })).toBe("11:55 AM\u201312:02 PM");
    expect(pickupWindowFor(at(8, 38), 4, S).end).toBe(at(8, 50));
  });

  it("a driver can't hold two scheduled cars less than 25 minutes apart", () => {
    expect(scheduleOverlaps(at(9), [at(9, 20)], S)).toBe(true);
    expect(scheduleOverlaps(at(9), [at(9, 25)], S)).toBe(false);
    expect(scheduleOverlaps(at(9), [at(8, 40)], S)).toBe(true);
    expect(scheduleOverlaps(at(9), [], S)).toBe(false);
  });
});

describe("cancels and strikes", () => {
  it("free until 30 minutes before", () => {
    expect(cancelIsFree(at(9), at(8, 30), S)).toBe(true);
    expect(cancelIsFree(at(9), at(8, 31), S)).toBe(false);
    expect(scheduleCancelText(at(9), at(8, 30), S, 0)).toBe("Cancelling is free.");
    expect(scheduleCancelText(at(9), at(8, 40), S, 0)).toMatch(/counts as a strike\. 2 strikes/);
    expect(scheduleCancelText(at(9), at(8, 40), S, 1)).toMatch(/won't be able to schedule for 7 days/);
  });

  it("2 strikes stop scheduling; strikes before a block or the window don't count", () => {
    expect(strikesBlock(1, S)).toBe(false);
    expect(strikesBlock(2, S)).toBe(true);
    const now = at(12);
    expect(strikesCountFrom(now, S, null)).toBe(now - 30 * DAY);
    expect(strikesCountFrom(now, S, now - DAY)).toBe(now - DAY);
    expect(scheduleBlockedText(Date.UTC(2026, 11, 4, 9, 30), S)).toBe(
      "You can't schedule rides until Fri 4 Dec, 9:30 AM, after 2 late cancels or missed pickups. You can still ride now.",
    );
  });
});

describe("words and prices", () => {
  it("labels", () => {
    expect(scheduledOfferLabel(at(9, 30), 3, 2100)).toBe("Scheduled · 9:30 AM · 3 seats · GH₵21");
    expect(joinCarLabel("Kofi", 1)).toBe("Join Kofi's car · 1 seat left");
    expect(goingLabel(at(9), 2)).toBe("9:00 AM · 2 going");
    expect(reserveButtonLabel(at(9), 1, 700)).toBe("Reserve seat · 9:00 AM · GH₵7");
    expect(reserveButtonLabel(at(9), 2, 1400)).toBe("Reserve 2 seats · 9:00 AM · GH₵14");
    expect(seatsFilledLabel(3, 4)).toBe("3 of 4 seats filled");
    expect(scheduleClock(at(14, 5))).toBe("2:05 PM");
    expect(scheduleTime(at(14, 5))).toBe("2:05");
    expect([0, 9, 12, 13, 16].map(scheduleHourLabel)).toEqual(["12 AM", "9 AM", "12 PM", "1 PM", "4 PM"]);
    expect(scheduledConfirmLine(at(9, 20), at(7))).toBe("Scheduled · arrive by 9:20 AM · Today");
  });

  it("the same prices as now: 7 / 14 / 18, far +2 a seat", () => {
    expect([1, 2, 3].map((n) => sharedFare(n, false, DEFAULT_FARE_PRICES))).toEqual([700, 1400, 1800]);
    expect([1, 2, 3].map((n) => sharedFare(n, true, DEFAULT_FARE_PRICES))).toEqual([900, 1800, 2400]);
  });
});

describe("settings", () => {
  it("defaults are valid", () => {
    expect(scheduleSettingsProblem(S)).toBeNull();
  });

  it("refuses numbers out of bounds or that contradict each other", () => {
    expect(scheduleSettingsProblem({ ...S, slotMinutes: 7 })).toMatch(/divide the hour/);
    expect(scheduleSettingsProblem({ ...S, offerLaterSeats: 3 })).toMatch(/fewer seats/);
    expect(scheduleSettingsProblem({ ...S, offerLaterMinutes: 25 })).toMatch(/before the/);
    expect(scheduleSettingsProblem({ ...S, soloLiveMinutes: 15 })).toMatch(/before booking closes/);
    expect(scheduleSettingsProblem({ ...S, carSeats: 9 })).toMatch(/between 2 and 4/);
  });

  it("reads a stored row, defaulting anything missing", () => {
    expect(readScheduleSettings(null)).toEqual(S);
    expect(readScheduleSettings({ enabled: false, slotMinutes: 15, carSeats: "x" })).toEqual({ ...S, enabled: false, slotMinutes: 15 });
  });
});

describe("the schedule screen", () => {
  const view = (h: number, m: number, extra: Partial<import("./scheduled").ScheduleSlotView> = {}) => ({
    arriveBy: new Date(at(h, m)).toISOString(),
    bookable: true,
    going: 0,
    join: null,
    ...extra,
  });
  const slots = [view(8, 0, { bookable: false }), view(8, 50), view(9, 0, { going: 2 }), view(9, 10, { join: { carId: "c1", driverFirstName: "Kofi", seatsLeft: 1 } }), view(10, 0)];

  it("hours still to come, and an hour's tiles", () => {
    expect(scheduleHours(slots, at(8, 10))).toEqual([8, 9, 10]);
    expect(scheduleHours(slots, at(9, 5))).toEqual([9, 10]);
    expect(slotsInHour(slots, 9).map((s) => scheduleClock(s.arriveBy))).toEqual(["9:00 AM", "9:10 AM"]);
  });

  it("join chips: cars with a driver first, then going your way", () => {
    expect(joinChips(slots).map((c) => c.label)).toEqual(["9:10 AM · Join Kofi's car · 1 seat left", "9:00 AM · 2 going"]);
    expect(joinChips(slots)[0]!.carId).toBe("c1");
    expect(firstChoice(slots)?.arriveBy).toBe(slots[3]!.arriveBy);
    expect(firstChoice([view(8, 0, { bookable: false }), view(8, 50)])?.arriveBy).toBe(view(8, 50).arriveBy);
  });

  it("'Need a ride sooner?' when under 20 minutes away with no car to join", () => {
    expect(needsLiveRideInstead(at(9), at(8, 45), S, false)).toBe(true);
    expect(needsLiveRideInstead(at(9), at(8, 45), S, true)).toBe(false);
    expect(needsLiveRideInstead(at(9), at(8, 40), S, false)).toBe(false);
  });
});

describe("late joins", () => {
  const neighbours = neighboursFrom([]);
  const b = (zone: string, seats = 1): GroupableBooking => ({ pickup: { zoneId: zone }, dropoff: { zoneId: "X" }, seats });

  it("a car with a driver can be joined until it leaves, with a seat, on the way, and time for the pickup", () => {
    const car = { leaveBy: at(9, 40), bookings: [b("A", 2)] };
    expect(lateJoinFits(car, b("A"), neighbours, S, at(9, 30), at(9, 37))).toBe(true);
    expect(lateJoinFits(car, b("A"), neighbours, S, at(9, 40), at(9, 37))).toBe(false); // it has left
    expect(lateJoinFits(car, b("Q"), neighbours, S, at(9, 30), at(9, 37))).toBe(false); // not on the way
    expect(lateJoinFits(car, b("A", 3), neighbours, S, at(9, 30), at(9, 37))).toBe(false); // no seats
    expect(lateJoinFits(car, b("A"), neighbours, S, at(9, 30), at(9, 29))).toBe(false); // no time for the extra pickup
    expect(lateJoinFits({ leaveBy: null, bookings: [] }, b("A"), neighbours, S, at(9, 30), at(9, 37))).toBe(false);
  });

  it("a slot past the cutoff is still open for a late join, until it passes", () => {
    expect(slotProblem(at(9, 30), DEFAULT_SERVICE_SETTINGS, S, at(9, 20), { lateJoin: true })).toBeNull();
    expect(slotProblem(at(9, 30), DEFAULT_SERVICE_SETTINGS, S, at(9, 30), { lateJoin: true })).toMatch(/has passed/);
  });
});

describe("the intro", () => {
  const base = { serverShow: true, freshLaunch: true, shownThisLaunch: false, dismissedForever: false, firstShownAt: null, now: at(9) };
  it("fresh launches only, until booked / Don't show again / 5 days / the admin switch", () => {
    expect(shouldShowScheduleIntro(base)).toBe(true);
    expect(shouldShowScheduleIntro({ ...base, freshLaunch: false })).toBe(false);
    expect(shouldShowScheduleIntro({ ...base, shownThisLaunch: true })).toBe(false);
    expect(shouldShowScheduleIntro({ ...base, dismissedForever: true })).toBe(false);
    expect(shouldShowScheduleIntro({ ...base, serverShow: false })).toBe(false);
    expect(shouldShowScheduleIntro({ ...base, firstShownAt: at(9) - 4 * DAY })).toBe(true);
    expect(shouldShowScheduleIntro({ ...base, firstShownAt: at(9) - 5 * DAY })).toBe(false);
    expect(SCHEDULE_INTRO_STEPS.map((s) => s.title)).toEqual(["Schedule ahead", "Join a car going your way", "Picked up on time"]);
  });
});

describe("compatibility: the same direction, a small detour", () => {
  // Rough points: the north end (Pentagon, TF) and the south end (Kwapong, ~2 km away).
  const PENTAGON = { zoneId: "N1", latitude: 5.662, longitude: -0.185 };
  const PENTAGON_2 = { zoneId: "N1", latitude: 5.6623, longitude: -0.1853 };
  const TF = { zoneId: "N2", latitude: 5.664, longitude: -0.183 };
  const KWAPONG = { zoneId: "S1", latitude: 5.643, longitude: -0.19 };
  const NEAR_TF = { zoneId: "N2", latitude: 5.6645, longitude: -0.1826 };
  const none = neighboursFrom([{ zoneId: "N2", adjacentZoneId: "S1" }]);
  const b = (pickup: typeof PENTAGON, dropoff: typeof TF, seats = 1): GroupableBooking => ({ pickup, dropoff, seats });

  it("Pentagon → TF and Pentagon → Kwapong are not one car (opposite wings), even with zones marked neighbours", () => {
    expect(extraRouteMeters([b(PENTAGON, TF)], b(PENTAGON_2, KWAPONG))!).toBeGreaterThan(2000);
    expect(bookingFitsCar(b(PENTAGON_2, KWAPONG), [b(PENTAGON, TF)], none, S)).toBe(false);
  });

  it("Pentagon → TF and Pentagon → next to TF are one car", () => {
    expect(bookingFitsCar(b(PENTAGON_2, NEAR_TF), [b(PENTAGON, TF)], none, S)).toBe(true);
  });

  it("a car short of riders takes a slightly longer detour; a fuller one doesn't", () => {
    const FARTHER = { zoneId: "N3", latitude: 5.6728, longitude: -0.183 }; // ~1.2 km on from TF
    const extra = extraRouteMeters([b(PENTAGON, TF)], b(PENTAGON_2, FARTHER))!;
    expect(extra).toBeGreaterThan(S.maxExtraMeters);
    expect(extra).toBeLessThan(S.sparseExtraMeters);
    expect(bookingFitsCar(b(PENTAGON_2, FARTHER), [b(PENTAGON, TF)], none, S)).toBe(true);
    expect(bookingFitsCar(b(PENTAGON_2, FARTHER), [b(PENTAGON, TF, 3)], none, S)).toBe(false);
    expect(drivingMinutes(1000)).toBeCloseTo(3, 0);
    expect(bookingFitsCar(b(PENTAGON_2, FARTHER), [b(PENTAGON, TF)], none, { ...S, maxExtraMinutes: 2 })).toBe(false);
  });

  it("stops in the best order: every pickup, then every drop-off, shortest route", () => {
    // Along one road, south to north: pickups at 1 and 2, drop-offs at 3 and 4.
    const p = (lat: number) => ({ zoneId: "Z", latitude: lat, longitude: -0.185 });
    const plan = planStops([b(p(5.652), p(5.666)), b(p(5.65), p(5.662)), b(p(5.654), p(5.664))])!;
    expect(plan.pickupOrder).toEqual([1, 0, 2]); // southmost first, heading north
    expect(plan.dropoffOrder).toEqual([1, 2, 0]); // nearest drop-off first
    expect(Math.round(plan.meters)).toBe(Math.round(haversineDistanceMeters(p(5.65), p(5.666)) * 1.3));
    expect(planStops([{ pickup: { zoneId: "A" }, dropoff: TF }])).toBeNull();
  });
});

describe("tiles and the driver's riders", () => {
  it("a tile's second line, pickable slots, one shared drop-off line", () => {
    expect(slotTileLine({ going: 2, join: null })).toBe("2 going your way");
    expect(slotTileLine({ going: 3, join: { carId: "c", driverFirstName: "Kofi", seatsLeft: 1 } })).toBe("Join Kofi's car \u00b7 1 seat left");
    expect(slotTileLine({ going: 0, join: null })).toBeNull();
    const v = (m: number, bookable = true) => ({ arriveBy: new Date(at(9, m)).toISOString(), bookable, going: 0, join: null });
    expect(pickableSlots([v(0), v(10, false), v(20)], at(9, 5)).map((x) => x.arriveBy)).toEqual([v(20).arriveBy]);
    expect(sharedDropoff([{ dropoffLabel: "Balme" }, { dropoffLabel: "Balme" }])).toBe("Balme");
    expect(sharedDropoff([{ dropoffLabel: "Balme" }, { dropoffLabel: "JQB" }])).toBeNull();
  });
});

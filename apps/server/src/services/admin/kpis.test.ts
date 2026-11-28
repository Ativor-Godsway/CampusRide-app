import { describe, expect, it } from "vitest";
import { computeKpis, isTestAccount, type KpiInput, type KpiRide, type KpiSeat } from "./kpis";

/**
 * The investor KPIs follow the week-1 report's definitions
 * (launch-analysis/week1/investor-kpis.md). Plain objects, no database.
 */

const T = (iso: string) => new Date(`2026-11-${iso}Z`);
const period = { from: T("23T00:00:00"), to: T("25T00:00:00") };

function ride(id: string, riderId: string, createdAt: string, over: Partial<KpiRide> = {}): KpiRide {
  return {
    id,
    riderId,
    driverId: null,
    type: "SHARED",
    status: "CANCELLED",
    booking: "LIVE",
    createdAt: T(createdAt),
    matchedAt: null,
    cancelReason: null,
    noDriverFoundAt: null,
    mergedIntoRideId: null,
    isReviewDemo: false,
    pickupNote: null,
    riderCancelNote: null,
    pickupPlaceId: "pl-night",
    dropoffPlaceId: null,
    pickupLat: null,
    pickupLng: null,
    dropoffLat: 5.6501,
    dropoffLng: -0.1871,
    pickupZoneId: "z1",
    dropoffZoneId: "z2",
    ...over,
  };
}

function seat(id: string, rideId: string, riderId: string, status: string, fare: number | null, createdAt: string, arrivedAt?: string): KpiSeat {
  return { id, rideId, riderId, status, seats: 1, fareCharged: fare, createdAt: T(createdAt), arrivedAt: arrivedAt ? T(arrivedAt) : null };
}

const user = (id: string, createdAt: string, over: Partial<{ phone: string; name: string; role: string; isReviewDemo: boolean }> = {}) => ({
  id,
  role: "RIDER",
  phone: `+23324${id.padStart(7, "0").slice(-7)}`,
  name: `Rider ${id}`,
  createdAt: T(createdAt),
  isReviewDemo: false,
  ...over,
});

function input(): KpiInput {
  return {
    users: [
      user("a", "20T10:00:00"),
      user("b", "23T09:00:00"),
      user("c", "24T09:00:00"),
      user("t", "23T09:00:00", { phone: "+233990000001" }),
      user("late", "26T09:00:00"),
      { ...user("d1", "01T00:00:00"), role: "DRIVER" },
    ],
    rides: [
      // a: completed on day 1 (accepted 20 s after the request).
      ride("r1", "a", "23T08:00:00", { driverId: "d1", status: "COMPLETED", matchedAt: T("23T08:00:20") }),
      // a: asks again 5 min later on day 1 (a retry): no driver found.
      ride("r2", "a", "23T08:05:00", { cancelReason: "NO_DRIVERS_AVAILABLE", noDriverFoundAt: T("23T08:12:00") }),
      // a: day 2, merged into b's car r4 and dropped off: completed.
      ride("r3", "a", "24T09:00:00", { cancelReason: "MERGED_INTO_ANOTHER_RIDE", mergedIntoRideId: "r4" }),
      // b: day 2, a driver cancels, rebooked to r5 which completes.
      ride("r4", "b", "24T08:58:00", { driverId: "d1", status: "COMPLETED", matchedAt: T("24T08:58:40") }),
      ride("r6", "c", "24T10:00:00", { driverId: "d1", status: "CANCELLED", matchedAt: T("24T10:00:30") }),
      ride("r5", "c", "24T10:03:00", { driverId: "d1", status: "COMPLETED", matchedAt: T("24T10:03:10") }),
      // A test account's ride, a "test ride" note and a review demo: all left out.
      ride("rt", "t", "23T10:00:00", { driverId: "d1", status: "COMPLETED", matchedAt: T("23T10:00:05") }),
      ride("rn", "b", "23T11:00:00", { pickupNote: "TEST RIDE please ignore" }),
      ride("rd", "b", "23T11:30:00", { isReviewDemo: true }),
      // Outside the period.
      ride("rx", "b", "25T08:00:00", { driverId: "d1", status: "COMPLETED", matchedAt: T("25T08:00:10") }),
    ],
    seats: [
      seat("s1", "r1", "a", "DROPPED_OFF", 700, "23T08:00:20", "23T08:06:20"),
      seat("s4b", "r4", "b", "DROPPED_OFF", 700, "24T08:58:40", "24T09:05:40"),
      seat("s4a", "r4", "a", "DROPPED_OFF", 700, "24T09:01:00", "24T09:08:00"),
      seat("s6", "r6", "c", "CANCELLED", null, "24T10:00:30"),
      seat("s5", "r5", "c", "DROPPED_OFF", 1500, "24T10:03:10", "24T10:09:10"),
      seat("st", "rt", "t", "DROPPED_OFF", 700, "23T10:00:05"),
      seat("sx", "rx", "b", "DROPPED_OFF", 700, "25T08:00:10"),
    ],
    driverCancels: [{ rideId: "r6", riderId: "c", rebookedRideId: "r5" }],
    places: [
      { id: "pl-night", name: "Night Market", latitude: 5.6505, longitude: -0.1862 },
      { id: "pl-balme", name: "Balme Library", latitude: 5.6502, longitude: -0.1872 },
    ],
    zones: new Map([
      ["z1", "Central"],
      ["z2", "North"],
    ]),
    rebookedIds: new Set(["r5"]),
  };
}

describe("computeKpis", () => {
  const k = computeKpis(input(), period, 1500);

  it("knows a test account", () => {
    expect(isTestAccount({ phone: "+233990000021", name: "Admin", isReviewDemo: false })).toBe(true);
    expect(isTestAccount({ phone: "+233099000021", name: "Admin", isReviewDemo: false })).toBe(true);
    expect(isTestAccount({ phone: "+233241234567", name: "Kofi (test)", isReviewDemo: false })).toBe(true);
    expect(isTestAccount({ phone: "+233241234567", name: "Kofi", isReviewDemo: false })).toBe(false);
  });

  it("counts requests, not the server's rebooks; follows rebooks and merges to the outcome", () => {
    // r1, r2, r3, r4, r6 (r5 is r6's rebook; test/demo/noted rides left out; rx outside).
    expect(k.kpis.requests).toBe(5);
    expect(k.kpis.tripAttempts).toBe(4); // r2 is a retry within 15 min
    expect(k.kpis.completedRides).toBe(4); // r1, r3 (merged, dropped off), r4, r6 → r5
    expect(k.kpis.completionPct).toBe(80);
    expect(k.kpis.completionPctOfAttempts).toBe(100);
    expect(k.kpis.noDriverPct).toBe(20);
  });

  it("works out GMV, car trips, riders per car and active drivers", () => {
    expect(k.kpis.gmvPesewas).toBe(700 + 700 + 700 + 1500);
    expect(k.kpis.carTrips).toBe(3); // r1, r4 and r5 (a rebook is a car journey too)
    expect(k.kpis.ridersPerCarTrip).toBe(1.33);
    expect(k.kpis.activeDrivers).toBe(1);
  });

  it("measures time to accept and the pickup wait as medians", () => {
    // r1 20 s, r3 merged: seat added 09:01:00 − 09:00:00 = 60 s, r4 40 s, r6 30 s.
    expect(k.kpis.medianAcceptSeconds).toBe(35);
    // r1 6, r3 7, r4 7, r6→r5: arrived 10:09:10 − accept 10:00:30 = 8.67 min
    expect(k.kpis.medianPickupWaitMin).toBe(7);
  });

  it("counts riders: registered at the end, sign-ups, requested, served, repeat", () => {
    expect(k.kpis.registeredRiders).toBe(3); // a, b, c (test and later sign-ups left out)
    expect(k.kpis.newSignups).toBe(2); // b, c
    expect(k.kpis.ridersRequested).toBe(3);
    expect(k.kpis.ridersServed).toBe(3);
    expect(k.kpis.repeatRiders).toBe(1); // a: r1 and r3
    expect(k.funnel.map((f) => f.riders)).toEqual([3, 3, 3, 1]);
    // a got a ride on day 1 and came back on day 2.
    expect(k.retention).toMatchObject({ cameBackBase: 1, cameBack: 1, cameBackPct: 100 });
  });

  it("gives per-day and per-hour series and top places (named, nearest within 150 m, else the zone)", () => {
    expect(k.daily.map((d) => [d.day, d.requests, d.completed, d.signups])).toEqual([
      ["2026-11-23", 2, 1, 1],
      ["2026-11-24", 3, 3, 1],
    ]);
    expect(k.byHour[8]).toEqual({ hour: 8, requests: 3, completed: 2 });
    expect(k.topPickups[0]).toEqual({ name: "Night Market", requests: 5, completed: 4 });
    expect(k.topDropoffs[0]!.name).toBe("Balme Library");
    expect(k.kpis.commissionAtRatePesewas).toBe(Math.round(3600 * 0.15));
  });
});

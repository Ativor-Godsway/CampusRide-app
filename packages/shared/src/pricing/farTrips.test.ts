import { describe, expect, it } from "vitest";
import {
  DEFAULT_FARE_PRICES,
  bookingPriceFor,
  farePricesProblem,
  isFarTrip,
  isValidBookingSeats,
  seatPriceFor,
  sharedFare,
  type FarEnd,
} from "./farTrips";
import { splitFare } from "./pricing";

const prices = DEFAULT_FARE_PRICES;
const trip = (pickupFarEnd: FarEnd | null, dropoffFarEnd: FarEnd | null) => ({ pickupFarEnd, dropoffFarEnd });
const shared = (a: FarEnd | null, b: FarEnd | null) => seatPriceFor("SHARED", trip(a, b), prices);

describe("far-trip pricing (two far ends)", () => {
  it("starts at GH₵7 normal and GH₵9 far", () => {
    expect(prices).toEqual({ sharedPesewas: 700, shared2Pesewas: 1400, shared3Pesewas: 1800, farPerSeatPesewas: 200, lonePesewas: 1500 });
  });

  it("North ↔ South is GH₵9, both directions", () => {
    expect(shared("NORTH", "SOUTH")).toBe(900);
    expect(shared("SOUTH", "NORTH")).toBe(900);
    expect(isFarTrip(trip("NORTH", "SOUTH"))).toBe(true);
    expect(isFarTrip(trip("SOUTH", "NORTH"))).toBe(true);
  });

  it("main campus ↔ North is GH₵7, both directions", () => {
    expect(shared(null, "NORTH")).toBe(700);
    expect(shared("NORTH", null)).toBe(700);
  });

  it("main campus ↔ South is GH₵7, both directions", () => {
    expect(shared(null, "SOUTH")).toBe(700);
    expect(shared("SOUTH", null)).toBe(700);
  });

  it("inside North, inside South and main campus ↔ main campus are GH₵7", () => {
    expect(shared("NORTH", "NORTH")).toBe(700);
    expect(shared("SOUTH", "SOUTH")).toBe(700);
    expect(shared(null, null)).toBe(700);
  });

  it("Ride alone is GH₵15 everywhere", () => {
    const ends: Array<FarEnd | null> = ["NORTH", "SOUTH", null];
    for (const a of ends) for (const b of ends) {
      expect(seatPriceFor("LONE", trip(a, b), prices)).toBe(1500);
      expect(seatPriceFor("LONE", trip(a, b), { ...prices, sharedPesewas: 100, farPerSeatPesewas: 900 })).toBe(1500);
    }
  });

  it("uses the admin's prices", () => {
    const custom = { ...prices, sharedPesewas: 800, farPerSeatPesewas: 200 };
    expect(seatPriceFor("SHARED", trip("NORTH", "SOUTH"), custom)).toBe(1000);
    expect(seatPriceFor("SHARED", trip("NORTH", null), custom)).toBe(800);
  });

  it("the driver keeps 85% of the far price and CampusRide 15%", () => {
    expect(splitFare(900)).toEqual({ commission: 135, driverShare: 765 });
  });

  it("refuses prices out of bounds, fewer seats dearer than more, or a far seat dearer than Ride alone", () => {
    expect(farePricesProblem(prices)).toBeNull();
    expect(farePricesProblem({ ...prices, sharedPesewas: 50 })).not.toBeNull();
    expect(farePricesProblem({ ...prices, shared2Pesewas: 1400.5 })).not.toBeNull();
    expect(farePricesProblem({ ...prices, lonePesewas: 20_000 })).not.toBeNull();
    expect(farePricesProblem({ ...prices, farPerSeatPesewas: -100 })).toMatch(/surcharge/);
    expect(farePricesProblem({ ...prices, farPerSeatPesewas: 0 })).toBeNull();
    expect(farePricesProblem({ ...prices, shared2Pesewas: 600 })).toMatch(/can't cost less/);
    expect(farePricesProblem({ ...prices, shared3Pesewas: 1300 })).toMatch(/can't cost less/);
    expect(farePricesProblem({ ...prices, sharedPesewas: 1400, shared2Pesewas: 1400, shared3Pesewas: 1800 })).toMatch(/Ride alone/);
  });
});

describe("seats in one booking (2026-11-26)", () => {
  it("Shared: 1 seat GH₵7, 2 seats GH₵14, 3 seats GH₵18", () => {
    expect([1, 2, 3].map((n) => sharedFare(n, false, prices))).toEqual([700, 1400, 1800]);
  });

  it("far trips add GH₵2 per seat: 9, 18, 24", () => {
    expect([1, 2, 3].map((n) => sharedFare(n, true, prices))).toEqual([900, 1800, 2400]);
    expect([1, 2, 3].map((n) => bookingPriceFor("SHARED", n, trip("SOUTH", "NORTH"), prices))).toEqual([900, 1800, 2400]);
  });

  it("Ride alone: GH₵15 for 1 to 4 people, far or not", () => {
    for (const n of [1, 2, 3, 4]) {
      expect(bookingPriceFor("LONE", n, trip(null, null), prices)).toBe(1500);
      expect(bookingPriceFor("LONE", n, trip("NORTH", "SOUTH"), prices)).toBe(1500);
    }
  });

  it("the admin's table", () => {
    const custom = { sharedPesewas: 800, shared2Pesewas: 1500, shared3Pesewas: 2000, farPerSeatPesewas: 300, lonePesewas: 1700 };
    expect([1, 2, 3].map((n) => sharedFare(n, true, custom))).toEqual([1100, 2100, 2900]);
    expect(bookingPriceFor("LONE", 3, trip(null, null), custom)).toBe(1700);
  });

  it("at most 3 seats Shared and 4 people Ride alone", () => {
    expect([0, 1, 2, 3, 4, 1.5, "2", null].map((n) => isValidBookingSeats("SHARED", n))).toEqual([
      false, true, true, true, false, false, false, false,
    ]);
    expect([1, 4, 5].map((n) => isValidBookingSeats("LONE", n))).toEqual([true, true, false]);
  });

  it("85/15 on the whole booking", () => {
    expect(splitFare(1400)).toEqual({ commission: 210, driverShare: 1190 });
  });
});

import { describe, expect, it } from "vitest";
import { DEFAULT_SHARED_FARE_PRICES, isFarTrip, seatPriceFor, sharedFarePricesProblem, type FarEnd } from "./farTrips";
import { splitFare } from "./pricing";

const prices = DEFAULT_SHARED_FARE_PRICES;
const trip = (pickupFarEnd: FarEnd | null, dropoffFarEnd: FarEnd | null) => ({ pickupFarEnd, dropoffFarEnd });
const shared = (a: FarEnd | null, b: FarEnd | null) => seatPriceFor("SHARED", trip(a, b), prices);

describe("far-trip pricing (two far ends)", () => {
  it("starts at GH₵7 normal and GH₵9 far", () => {
    expect(prices).toEqual({ sharedPesewas: 700, sharedFarPesewas: 900 });
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
      expect(seatPriceFor("LONE", trip(a, b), { sharedPesewas: 100, sharedFarPesewas: 200 })).toBe(1500);
    }
  });

  it("uses the admin's prices", () => {
    const custom = { sharedPesewas: 800, sharedFarPesewas: 1000 };
    expect(seatPriceFor("SHARED", trip("NORTH", "SOUTH"), custom)).toBe(1000);
    expect(seatPriceFor("SHARED", trip("NORTH", null), custom)).toBe(800);
  });

  it("the driver keeps 85% of the far price and CampusRide 15%", () => {
    expect(splitFare(900)).toEqual({ commission: 135, driverShare: 765 });
  });

  it("refuses prices out of bounds or a far seat dearer than Ride alone", () => {
    expect(sharedFarePricesProblem(prices)).toBeNull();
    expect(sharedFarePricesProblem({ sharedPesewas: 50, sharedFarPesewas: 900 })).not.toBeNull();
    expect(sharedFarePricesProblem({ sharedPesewas: 700, sharedFarPesewas: 900.5 })).not.toBeNull();
    expect(sharedFarePricesProblem({ sharedPesewas: 700, sharedFarPesewas: 1600 })).toMatch(/Ride alone/);
  });
});

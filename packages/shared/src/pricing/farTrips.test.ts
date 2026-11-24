import { describe, expect, it } from "vitest";
import { DEFAULT_SHARED_FARE_PRICES, crossesFarArea, seatPriceFor, sharedFarePricesProblem } from "./farTrips";
import { splitFare } from "./pricing";

const prices = DEFAULT_SHARED_FARE_PRICES;
const ends = (pickupInFarArea: boolean, dropoffInFarArea: boolean) => ({ pickupInFarArea, dropoffInFarArea });

describe("far-trip pricing", () => {
  it("starts at GH₵7 normal and GH₵9 far", () => {
    expect(prices).toEqual({ sharedPesewas: 700, sharedFarPesewas: 900 });
  });

  it("a Shared trip crossing between the far area and the rest of campus is GH₵9, either way round", () => {
    expect(crossesFarArea(ends(true, false))).toBe(true);
    expect(crossesFarArea(ends(false, true))).toBe(true);
    expect(seatPriceFor("SHARED", ends(true, false), prices)).toBe(900);
    expect(seatPriceFor("SHARED", ends(false, true), prices)).toBe(900);
  });

  it("both ends in the far area, or neither, stays GH₵7", () => {
    expect(seatPriceFor("SHARED", ends(true, true), prices)).toBe(700);
    expect(seatPriceFor("SHARED", ends(false, false), prices)).toBe(700);
  });

  it("Ride alone is GH₵15 everywhere", () => {
    for (const [a, b] of [[true, false], [false, true], [true, true], [false, false]] as const) {
      expect(seatPriceFor("LONE", ends(a, b), prices)).toBe(1500);
      expect(seatPriceFor("LONE", ends(a, b), { sharedPesewas: 100, sharedFarPesewas: 200 })).toBe(1500);
    }
  });

  it("uses the admin's prices", () => {
    const custom = { sharedPesewas: 800, sharedFarPesewas: 1000 };
    expect(seatPriceFor("SHARED", ends(true, false), custom)).toBe(1000);
    expect(seatPriceFor("SHARED", ends(false, false), custom)).toBe(800);
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

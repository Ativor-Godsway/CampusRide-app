import { describe, expect, it } from "vitest";
import {
  autoAddOn,
  bestMovingCar,
  joinedCarText,
  movingCarFit,
  movingOfferLine,
  onYourWayLabel,
  riderAddedText,
  shortestRoute,
} from "./movingCar";

const LIM = { maxExtraMeters: 1000, maxExtraMinutes: 5 };
// Along one road, south → north (about 220 m per 0.002° of latitude).
const p = (lat: number, lng = -0.185) => ({ latitude: lat, longitude: lng });

describe("moving car fit", () => {
  const car = { from: p(5.65), pickups: [], dropoffs: [p(5.664)] };

  it("a rider on the way adds almost nothing; one going the other way doesn't fit", () => {
    const on = movingCarFit(car, p(5.654), p(5.662), LIM);
    expect(on.extraMeters).toBeLessThan(50);
    expect(on.fits).toBe(true);
    expect(on.pickupEtaMinutes).toBeGreaterThanOrEqual(1);
    const back = movingCarFit(car, p(5.654), p(5.64), LIM);
    expect(back.extraMeters).toBeGreaterThan(2000);
    expect(back.fits).toBe(false);
  });

  it("the minutes limit applies too", () => {
    const off = movingCarFit(car, p(5.654, -0.1835), p(5.664, -0.1835), LIM);
    expect(off.fits).toBe(off.extraMeters <= 1000 && off.extraMinutes <= 5);
    expect(movingCarFit(car, p(5.654, -0.1835), p(5.664, -0.1835), { maxExtraMeters: 1000, maxExtraMinutes: 0.01 }).fits).toBe(false);
  });

  it("stops in shortest order: pickups first, nearest first", () => {
    const r = shortestRoute({ from: p(5.65), pickups: [p(5.656), p(5.652)], dropoffs: [p(5.66)] });
    expect(r.stops).toEqual([
      { kind: "PICKUP", index: 1 },
      { kind: "PICKUP", index: 0 },
      { kind: "DROPOFF", index: 0 },
    ]);
  });

  it("the best car is the one that adds least; none fits: null", () => {
    const cars = [
      { car: "stops-short", route: { from: p(5.645), pickups: [], dropoffs: [p(5.66)] } },
      { car: "on-the-way", route: { from: p(5.645), pickups: [], dropoffs: [p(5.664)] } },
      { car: "wrong-way", route: { from: p(5.654), pickups: [], dropoffs: [p(5.64)] } },
    ];
    // Both reach the pickup; one would have to drive 300 m further for the drop-off.
    expect(bestMovingCar(cars, p(5.653), p(5.663), LIM)?.car).toBe("on-the-way");
    // A tie on route: the car that reaches the pickup sooner.
    const tie = [
      { car: "behind", route: { from: p(5.645), pickups: [], dropoffs: [p(5.664)] } },
      { car: "close", route: { from: p(5.652), pickups: [], dropoffs: [p(5.664)] } },
    ];
    expect(bestMovingCar(tie, p(5.653), p(5.663), LIM)?.car).toBe("close");
    expect(bestMovingCar(cars.slice(2), p(5.653), p(5.663), LIM)).toBeNull();
  });
});

describe("words", () => {
  it("banner, on-trip offer, board, rider", () => {
    expect(riderAddedText({ firstName: "Ama", pickupLabel: "Pentagon Block C", seats: 2, farePesewas: 1400, extraMinutes: 2.6 })).toBe(
      "Rider added · Ama · Pentagon Block C · 2 seats · +GH₵14 · +3 min",
    );
    expect(riderAddedText({ firstName: "Ama", pickupLabel: "JQB", seats: 1, farePesewas: 700, extraMinutes: 0.2 })).toBe("Rider added · Ama · JQB · +GH₵7 · +1 min");
    expect(movingOfferLine({ farePesewas: 700, extraMinutes: 3, from: "Pentagon Block C", to: "JQB" })).toBe("+GH₵7 · +3 min · Pentagon Block C → JQB");
    expect(onYourWayLabel(2.7)).toBe("On your way · +3 min");
    expect(joinedCarText("Kofi", 4)).toBe("You've joined Kofi's car, already on the way. Pickup in about 4 min");
  });

  it("auto-add: the driver's choice, else the admin default", () => {
    expect(autoAddOn(null, true)).toBe(true);
    expect(autoAddOn(false, true)).toBe(false);
    expect(autoAddOn(true, false)).toBe(true);
  });
});

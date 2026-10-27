import { describe, it, expect } from "vitest";
import {
  bearingBetween,
  carHeading,
  continueAngle,
  normalizeDegrees,
  routeBearingAt,
  screenAngle,
  shortestTurn,
} from "./heading";
import { trimPathToPosition } from "./tripRoute";

// 0.0001° of latitude is about 11 m; on campus (5.65° N) so is 0.0001° of longitude.
const at = (latitude: number, longitude: number) => ({ latitude, longitude });
const O = at(5.65, -0.187);

/** A road east along the campus for ~220 m, then north for ~110 m. */
const ROAD = [at(5.65, -0.187), at(5.65, -0.185), at(5.651, -0.185)];

describe("normalizeDegrees", () => {
  it("folds any angle into [0, 360)", () => {
    expect(normalizeDegrees(0)).toBe(0);
    expect(normalizeDegrees(360)).toBe(0);
    expect(normalizeDegrees(-360)).toBe(0);
    expect(Object.is(normalizeDegrees(-360), 0)).toBe(true);
    expect(normalizeDegrees(370)).toBe(10);
    expect(normalizeDegrees(-10)).toBe(350);
    expect(normalizeDegrees(-730)).toBe(350);
  });
});

describe("bearingBetween", () => {
  it("gives compass bearings: north 0, east 90, south 180, west 270", () => {
    expect(bearingBetween(O, at(5.651, -0.187))).toBeCloseTo(0, 3);
    expect(bearingBetween(O, at(5.65, -0.186))).toBeCloseTo(90, 1);
    expect(bearingBetween(O, at(5.649, -0.187))).toBeCloseTo(180, 3);
    expect(bearingBetween(O, at(5.65, -0.188))).toBeCloseTo(270, 1);
  });

  it("gives about 45 going north-east", () => {
    expect(bearingBetween(O, at(5.6501, -0.1869))).toBeCloseTo(45, 0);
  });
});

describe("shortestTurn", () => {
  it("turns the short way round across north", () => {
    expect(shortestTurn(350, 10)).toBe(20);
    expect(shortestTurn(10, 350)).toBe(-20);
  });

  it("turns the short way within a turn", () => {
    expect(shortestTurn(90, 180)).toBe(90);
    expect(shortestTurn(180, 90)).toBe(-90);
    expect(shortestTurn(45, 45)).toBe(0);
  });

  it("turns +180 (not -180) for a U-turn", () => {
    expect(shortestTurn(0, 180)).toBe(180);
    expect(shortestTurn(180, 0)).toBe(180);
  });

  it("copes with angles outside [0, 360)", () => {
    expect(shortestTurn(710, 10)).toBe(20);
    expect(shortestTurn(-10, 370)).toBe(20);
  });
});

describe("continueAngle", () => {
  it("goes from 350 to 370 (on screen: 10) rather than back down to 10", () => {
    expect(continueAngle(350, 10)).toBe(370);
  });

  it("goes from 10 to -10 (on screen: 350)", () => {
    expect(continueAngle(10, 350)).toBe(-10);
  });

  it("keeps counting from an angle already past a full turn", () => {
    expect(continueAngle(725, 0)).toBe(720);
    expect(continueAngle(-350, 90)).toBe(-270);
  });
});

describe("screenAngle", () => {
  it("is the bearing itself on a north-up map", () => {
    expect(screenAngle(90, 0)).toBe(90);
  });

  it("takes off the map's own turn: a car heading east on an east-up map points up", () => {
    expect(screenAngle(90, 90)).toBe(0);
  });

  it("wraps round north", () => {
    expect(screenAngle(10, 30)).toBe(340);
    expect(screenAngle(350, 340)).toBe(10);
    expect(screenAngle(0, 270)).toBe(90);
  });
});

describe("routeBearingAt", () => {
  it("is null with no route, or one point", () => {
    expect(routeBearingAt(O, undefined)).toBeNull();
    expect(routeBearingAt(O, null)).toBeNull();
    expect(routeBearingAt(O, [O])).toBeNull();
  });

  it("follows the segment nearest the car", () => {
    expect(routeBearingAt(at(5.65003, -0.186), ROAD)).toBeCloseTo(90, 1);
    expect(routeBearingAt(at(5.6505, -0.18503), ROAD)).toBeCloseTo(0, 3);
  });

  it("is null when the car is too far from the route", () => {
    // ~55 m north of the eastbound stretch, ~55 m west of the northbound one.
    expect(routeBearingAt(at(5.6505, -0.1855), ROAD)).toBeNull();
    expect(routeBearingAt(at(5.6505, -0.1855), ROAD, 60)).not.toBeNull();
  });

  it("at a corner takes the road ahead", () => {
    expect(routeBearingAt(at(5.65, -0.185), ROAD)).toBeCloseTo(0, 3);
  });

  it("skips the line a trimmed route draws from the car to the road", () => {
    // The car is ~11 m north of the road, so the first segment points due south.
    const car = at(5.6501, -0.186);
    const trimmed = trimPathToPosition(ROAD, car);
    expect(bearingBetween(trimmed[0]!, trimmed[1]!)).toBeCloseTo(180, 0);
    expect(routeBearingAt(car, trimmed)).toBeCloseTo(90, 1);
  });

  it("skips repeated points", () => {
    expect(routeBearingAt(at(5.65003, -0.186), [ROAD[0]!, ROAD[0]!, ROAD[1]!])).toBeCloseTo(90, 1);
  });
});

describe("carHeading", () => {
  it("follows the road rather than GPS wobble", () => {
    // Moving east along the road, but this fix drifted ~6 m north.
    const heading = carHeading({
      previous: at(5.65, -0.1865),
      current: at(5.65005, -0.1863),
      route: ROAD,
      heading: 0,
    });
    expect(heading).toBeCloseTo(90, 1);
  });

  it("uses its own movement when going against the route", () => {
    const heading = carHeading({
      previous: at(5.65, -0.186),
      current: at(5.65, -0.1862),
      route: ROAD,
      heading: 90,
    });
    expect(heading).toBeCloseTo(270, 1);
  });

  it("uses the last two fixes away from the route", () => {
    const heading = carHeading({
      previous: at(5.66, -0.19),
      current: at(5.6601, -0.19),
      route: ROAD,
      heading: 90,
    });
    expect(heading).toBeCloseTo(0, 3);
  });

  it("uses the last two fixes when there's no route", () => {
    const heading = carHeading({ previous: O, current: at(5.649, -0.187), heading: 0 });
    expect(heading).toBeCloseTo(180, 3);
  });

  it("keeps its heading for a move under 3 m (a parked car doesn't spin)", () => {
    const heading = carHeading({ previous: O, current: at(5.65001, -0.18701), route: ROAD, heading: 123 });
    expect(heading).toBe(123);
  });

  it("on the first fix faces along the road, or keeps its heading off it", () => {
    expect(carHeading({ previous: null, current: at(5.65, -0.186), route: ROAD, heading: 0 })).toBeCloseTo(90, 1);
    expect(carHeading({ previous: null, current: at(5.66, -0.19), route: ROAD, heading: 45 })).toBe(45);
  });

  it("stays unknown (null) until the car moves or is on the route", () => {
    expect(carHeading({ previous: null, current: at(5.66, -0.19), route: ROAD, heading: null })).toBeNull();
    expect(carHeading({ previous: O, current: at(5.65001, -0.18701), heading: null })).toBeNull();
  });
});

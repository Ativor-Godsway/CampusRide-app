import { describe, expect, it } from "vitest";
import { haversineDistanceMeters } from "@rida/shared";
import {
  FakeDriverOptionError,
  parseFakeDriverOptions,
  pickOwnRequest,
  positionsAlong,
  shortDistance,
} from "./fakeDriverPlan";

describe("fake driver options", () => {
  it("defaults to 30 km/h, a 10 s wait, starting at Main Gate, the local server", () => {
    expect(parseFakeDriverOptions([], { PORT: "3000" })).toEqual({
      speedKmh: 30,
      waitSec: 10,
      at: "Main Gate",
      apiUrl: "http://localhost:3000",
      help: false,
    });
  });

  it("takes --speed, --wait, --at and refuses nonsense", () => {
    expect(parseFakeDriverOptions(["--speed", "60", "--wait=3", "--at", "Night Market"])).toMatchObject({
      speedKmh: 60,
      waitSec: 3,
      at: "Night Market",
    });
    expect(() => parseFakeDriverOptions(["--speed", "500"])).toThrow(FakeDriverOptionError);
    expect(() => parseFakeDriverOptions(["--wait", "x"])).toThrow(FakeDriverOptionError);
    expect(() => parseFakeDriverOptions(["--fly"])).toThrow(FakeDriverOptionError);
  });
});

describe("which request it accepts", () => {
  it("the newest from a real rider — never one of sim:riders' fake riders", () => {
    const at = (m: number) => new Date(Date.UTC(2026, 9, 13, 10, m));
    const pick = pickOwnRequest([
      { id: "old-mine", riderPhone: "+233241234567", createdAt: at(1) },
      { id: "new-mine", riderPhone: "+233241234567", createdAt: at(5) },
      { id: "fake", riderPhone: "+233099000003", createdAt: at(9) },
    ]);
    expect(pick?.id).toBe("new-mine");
    expect(pickOwnRequest([{ id: "fake", riderPhone: "+233099000001", createdAt: at(1) }])).toBeNull();
  });
});

describe("driving the road", () => {
  // ~330 m north.
  const road = [
    { latitude: 5.65, longitude: -0.187 },
    { latitude: 5.653, longitude: -0.187 },
  ];

  it("reports a position about every second at the given speed, ending exactly at the destination", () => {
    const points = positionsAlong(road, 36); // 10 m/s
    expect(points.length).toBe(34); // 33 steps of 10 m, then the end
    expect(haversineDistanceMeters(road[0]!, points[0]!)).toBeCloseTo(10, 0);
    expect(haversineDistanceMeters(points[0]!, points[1]!)).toBeCloseTo(10, 0);
    expect(points.at(-1)).toEqual(road[1]);
  });

  it("is slower at a lower speed, and copes with an empty or one-point road", () => {
    expect(positionsAlong(road, 18).length).toBeGreaterThan(positionsAlong(road, 36).length);
    expect(positionsAlong([], 30)).toEqual([]);
    expect(positionsAlong([road[0]!], 30)).toEqual([road[0]]);
  });

  it("says distances plainly", () => {
    expect(shortDistance(1234)).toBe("1.2 km");
    expect(shortDistance(347)).toBe("350 m");
  });
});

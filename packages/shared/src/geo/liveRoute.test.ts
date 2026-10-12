import { describe, expect, it } from "vitest";
import {
  REROUTE_MIN_INTERVAL_MS,
  distanceToPathMeters,
  isOnRoute,
  pointsKey,
  remainingSeconds,
  shouldReroute,
} from "./liveRoute";

// A straight road north, ~330 m.
const path = [
  { latitude: 5.65, longitude: -0.187 },
  { latitude: 5.653, longitude: -0.187 },
];

describe("following a route", () => {
  it("measures how far a point is from the road", () => {
    expect(distanceToPathMeters({ latitude: 5.6515, longitude: -0.187 }, path)).toBeLessThan(1);
    expect(distanceToPathMeters({ latitude: 5.6515, longitude: -0.1865 }, path)).toBeCloseTo(55, -1);
    expect(isOnRoute({ latitude: 5.6515, longitude: -0.1866 }, path)).toBe(true); // ~44 m
    expect(isOnRoute({ latitude: 5.6515, longitude: -0.186 }, path)).toBe(false); // ~110 m
  });

  it("asks again when the stops change, when the car leaves the road, or after a failure — never twice in 30 s", () => {
    const base = { hasRoute: true, routedFor: "A", stopsKey: "A", position: { latitude: 5.6515, longitude: -0.187 }, path, lastAskedAt: 0, now: 1_000 };
    expect(shouldReroute(base)).toBe(false); // on the road
    expect(shouldReroute({ ...base, stopsKey: "B" })).toBe(true); // stops changed: at once
    const off = { ...base, position: { latitude: 5.6515, longitude: -0.186 } };
    expect(shouldReroute(off)).toBe(false); // off the road, but asked 1 s ago
    expect(shouldReroute({ ...off, now: REROUTE_MIN_INTERVAL_MS + 1 })).toBe(true);
    expect(shouldReroute({ ...base, hasRoute: false, now: REROUTE_MIN_INTERVAL_MS + 1 })).toBe(true);
    expect(shouldReroute({ ...base, hasRoute: false })).toBe(false);
  });

  it("keys points as the server caches them, and scales the time left", () => {
    expect(pointsKey(path)).toBe("5.6500,-0.1870|5.6530,-0.1870");
    expect(remainingSeconds(path, [{ latitude: 5.6515, longitude: -0.187 }, path[1]!], 120)).toBeCloseTo(60, 0);
    expect(remainingSeconds([], [], 100)).toBeNull();
  });
});

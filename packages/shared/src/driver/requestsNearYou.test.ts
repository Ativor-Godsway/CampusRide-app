import { describe, expect, it } from "vitest";
import {
  filterRequestsByType,
  formatDistance,
  requestedAgo,
  sortRequestsNearestFirst,
} from "./requestsNearYou";

const zones = [
  { id: "near", latitude: 5.65, longitude: -0.186 },
  { id: "mid", latitude: 5.655, longitude: -0.186 },
  { id: "far", latitude: 5.67, longitude: -0.186 },
];
const driver = { latitude: 5.65, longitude: -0.186 };

const req = (rideId: string, pickupZoneId: string, type: "LONE" | "SHARED", createdAt: string) => ({
  rideId,
  pickupZoneId,
  type,
  createdAt,
});

describe("sortRequestsNearestFirst", () => {
  it("orders by distance from the driver to the pickup zone", () => {
    const sorted = sortRequestsNearestFirst(
      [
        req("a", "far", "LONE", "2026-09-29T10:00:00Z"),
        req("b", "near", "SHARED", "2026-09-29T10:01:00Z"),
        req("c", "mid", "SHARED", "2026-09-29T10:02:00Z"),
      ],
      driver,
      zones,
    );
    expect(sorted.map((r) => r.rideId)).toEqual(["b", "c", "a"]);
    expect(sorted[0].distanceMeters).toBeCloseTo(0, 0);
    expect(sorted[1].distanceMeters).toBeGreaterThan(500);
  });

  it("puts unmeasurable requests last, oldest first", () => {
    const sorted = sortRequestsNearestFirst(
      [
        req("unknownNew", "nowhere", "LONE", "2026-09-29T10:05:00Z"),
        req("unknownOld", "nowhere", "LONE", "2026-09-29T10:00:00Z"),
        req("mid", "mid", "LONE", "2026-09-29T10:03:00Z"),
      ],
      driver,
      zones,
    );
    expect(sorted.map((r) => r.rideId)).toEqual(["mid", "unknownOld", "unknownNew"]);
  });

  it("without a GPS fix, keeps the oldest request first", () => {
    const sorted = sortRequestsNearestFirst(
      [req("new", "near", "LONE", "2026-09-29T10:05:00Z"), req("old", "far", "LONE", "2026-09-29T10:00:00Z")],
      null,
      zones,
    );
    expect(sorted.map((r) => r.rideId)).toEqual(["old", "new"]);
    expect(sorted.every((r) => r.distanceMeters === null)).toBe(true);
  });
});

describe("filterRequestsByType", () => {
  const list = [req("s", "near", "SHARED", "x"), req("p", "near", "LONE", "x")];
  it("All keeps everything; Shared and Private narrow", () => {
    expect(filterRequestsByType(list, "ALL").map((r) => r.rideId)).toEqual(["s", "p"]);
    expect(filterRequestsByType(list, "SHARED").map((r) => r.rideId)).toEqual(["s"]);
    expect(filterRequestsByType(list, "LONE").map((r) => r.rideId)).toEqual(["p"]);
  });
});

describe("formatDistance", () => {
  it("rounds metres and switches to km at 1000", () => {
    expect(formatDistance(0)).toBe("50 m");
    expect(formatDistance(349)).toBe("350 m");
    expect(formatDistance(999)).toBe("1.0 km");
    expect(formatDistance(1000)).toBe("1.0 km");
    expect(formatDistance(1440)).toBe("1.4 km");
  });
});

describe("requestedAgo", () => {
  const now = Date.parse("2026-09-29T10:10:00Z");
  it("reads naturally", () => {
    expect(requestedAgo("2026-09-29T10:09:30Z", now)).toBe("Requested just now");
    expect(requestedAgo("2026-09-29T10:07:00Z", now)).toBe("Requested 3 min ago");
  });
});

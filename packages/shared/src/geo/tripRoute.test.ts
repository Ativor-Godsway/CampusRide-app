import { describe, expect, it } from "vitest";
import { encodePolyline, pathLengthMeters } from "./polyline";
import {
  STOP_DWELL_SECONDS,
  etaToStopMinutes,
  indexRoutes,
  legSeconds,
  pathBetweenZones,
  pathFromDriver,
  planSeconds,
  straightLineSeconds,
  trimPathToPosition,
  tripPath,
} from "./tripRoute";

const A = { id: "A", latitude: 5.65, longitude: -0.186 };
const B = { id: "B", latitude: 5.653, longitude: -0.186 };
const C = { id: "C", latitude: 5.656, longitude: -0.186 };
const zones = [A, B, C];
const bend = [
  { latitude: 5.65, longitude: -0.186 },
  { latitude: 5.6515, longitude: -0.1875 },
  { latitude: 5.653, longitude: -0.186 },
];
const routes = indexRoutes([{ fromZoneId: "A", toZoneId: "B", polyline: encodePolyline(bend), durationSeconds: 120 }]);

describe("trip route", () => {
  it("uses the stored road route, and a straight line when there is none", () => {
    expect(pathBetweenZones(A, B, routes)).toEqual(bend);
    expect(pathBetweenZones(B, A, routes)).toHaveLength(2); // one-way: B→A not stored
  });

  it("joins the driver's exact position to the route from their zone", () => {
    const driver = { latitude: 5.6501, longitude: -0.1861 };
    const path = pathFromDriver(driver, B, zones, routes);
    expect(path[0]).toEqual(driver);
    expect(path[path.length - 1]).toEqual(bend[2]);
    expect(pathFromDriver({ latitude: 5.6531, longitude: -0.186 }, B, zones, routes)).toHaveLength(2);
  });

  it("trims the part of the route already driven, so the line starts at the car", () => {
    // Halfway along the first bend segment, on the road.
    const onRoad = { latitude: 5.65075, longitude: -0.18675 };
    const path = trimPathToPosition(bend, onRoad);
    expect(path[0]).toEqual(onRoad);
    expect(path[1]!.latitude).toBeCloseTo(5.65075, 5);
    expect(path.slice(2)).toEqual(bend.slice(1)); // the first vertex (already passed) is gone
    expect(pathLengthMeters(path)).toBeLessThan(pathLengthMeters(bend));
  });

  it("doesn't trim when the driver is off the route — it joins them to its start", () => {
    const far = { latitude: 5.66, longitude: -0.2 };
    expect(trimPathToPosition(bend, far)).toEqual([far, ...bend]);
  });

  it("chains the stops into one line without repeating shared points", () => {
    const path = tripPath(null, [A, B, C], zones, routes);
    expect(path[0]).toEqual(A);
    expect(path).toHaveLength(bend.length + 1); // A…B bend, then straight to C
    expect(tripPath(null, [], zones, routes)).toEqual([]);
  });

  it("estimates the time to a stop from the stored route", () => {
    expect(etaToStopMinutes({ latitude: 5.6501, longitude: -0.186 }, B, zones, routes)).toBe(2);
    expect(etaToStopMinutes(null, B, zones, routes)).toBeNull();
  });
});

describe("plan driving time", () => {
  it("uses the stored route's time, the straight-line estimate otherwise, and nothing within a zone", () => {
    expect(legSeconds(A, B, routes)).toBe(120);
    expect(legSeconds(B, C, routes)).toBeCloseTo(straightLineSeconds(B, C), 6);
    expect(legSeconds(B, B, routes)).toBe(0);
  });

  it("adds up driving legs plus a dwell per stop", () => {
    expect(planSeconds(null, [A, B, C], zones, routes)).toBeCloseTo(120 + straightLineSeconds(B, C) + 3 * STOP_DWELL_SECONDS, 6);
    expect(planSeconds(null, [], zones, routes)).toBe(0);
  });
});

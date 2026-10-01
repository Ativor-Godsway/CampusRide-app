import { describe, expect, it } from "vitest";
import { encodePolyline } from "./polyline";
import { etaToStopMinutes, indexRoutes, pathBetweenZones, pathFromDriver, tripPath } from "./tripRoute";

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
    expect(path.slice(1)).toEqual(bend);
    expect(pathFromDriver({ latitude: 5.6531, longitude: -0.186 }, B, zones, routes)).toHaveLength(2);
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

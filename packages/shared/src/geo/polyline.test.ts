import { describe, expect, it } from "vitest";
import { decodePolyline, encodePolyline, pathLengthMeters, pointAlongPath } from "./polyline";

describe("polyline", () => {
  it("decodes Google's documented example", () => {
    const pts = decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
    expect(pts).toEqual([
      { latitude: 38.5, longitude: -120.2 },
      { latitude: 40.7, longitude: -120.95 },
      { latitude: 43.252, longitude: -126.453 },
    ]);
  });

  it("round-trips campus coordinates", () => {
    const path = [
      { latitude: 5.6502, longitude: -0.1862 },
      { latitude: 5.6533, longitude: -0.1874 },
    ];
    expect(decodePolyline(encodePolyline(path))).toEqual(path);
  });

  it("returns [] for junk instead of throwing", () => {
    expect(decodePolyline("")).toEqual([]);
    expect(decodePolyline("~")).toEqual([]);
  });

  it("walks a path by distance, clamped to its ends", () => {
    const path = [
      { latitude: 0, longitude: 0 },
      { latitude: 0, longitude: 0.001 },
      { latitude: 0.001, longitude: 0.001 },
    ];
    const len = pathLengthMeters(path);
    expect(len).toBeGreaterThan(220);
    expect(pointAlongPath(path, 0)).toEqual(path[0]);
    expect(pointAlongPath(path, len + 50)).toEqual(path[2]);
    const mid = pointAlongPath(path, len / 4)!;
    expect(mid.latitude).toBe(0);
    expect(mid.longitude).toBeCloseTo(0.0005, 5);
    expect(pointAlongPath([], 10)).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import { haversineDistanceMeters, nearestZone, zonesWithinRadius } from "./distance";

// Real campus zone coordinates (subset of the Phase 0 seed).
const MAIN_GATE = { id: "main-gate", name: "Main Gate", latitude: 5.6502, longitude: -0.1862 };
const LEGON_HALL = { id: "legon-hall", name: "Legon Hall", latitude: 5.6523, longitude: -0.1871 };
const COMMONWEALTH = {
  id: "commonwealth",
  name: "Commonwealth Hall",
  latitude: 5.6518,
  longitude: -0.1855,
};
const ACCRA_MALL = {
  id: "accra-mall",
  name: "Accra Mall Junction",
  latitude: 5.649,
  longitude: -0.1856,
};

const ZONES = [MAIN_GATE, LEGON_HALL, COMMONWEALTH, ACCRA_MALL];

describe("haversineDistanceMeters", () => {
  it("returns 0 for identical points", () => {
    expect(haversineDistanceMeters(MAIN_GATE, MAIN_GATE)).toBe(0);
  });

  it("returns a small positive distance for nearby campus zones", () => {
    const distance = haversineDistanceMeters(MAIN_GATE, LEGON_HALL);
    // These two points are roughly 250-350m apart.
    expect(distance).toBeGreaterThan(200);
    expect(distance).toBeLessThan(400);
  });

  it("is symmetric", () => {
    const ab = haversineDistanceMeters(MAIN_GATE, ACCRA_MALL);
    const ba = haversineDistanceMeters(ACCRA_MALL, MAIN_GATE);
    expect(ab).toBeCloseTo(ba, 6);
  });
});

describe("nearestZone", () => {
  it("returns the closest zone by distance", () => {
    // A point right on top of Commonwealth Hall.
    const result = nearestZone(COMMONWEALTH.latitude, COMMONWEALTH.longitude, ZONES);
    expect(result?.id).toBe("commonwealth");
  });

  it("picks the nearer of two close zones", () => {
    // Slightly closer to Main Gate than Legon Hall.
    const result = nearestZone(5.6504, -0.1863, [MAIN_GATE, LEGON_HALL]);
    expect(result?.id).toBe("main-gate");
  });

  it("returns null for an empty zone list", () => {
    expect(nearestZone(5.65, -0.186, [])).toBeNull();
  });
});

describe("zonesWithinRadius", () => {
  it("returns only zones within the radius, nearest first", () => {
    // Main Gate <-> Commonwealth ~194m, <-> Accra Mall ~149m, <-> Legon Hall ~254m.
    const result = zonesWithinRadius(MAIN_GATE.latitude, MAIN_GATE.longitude, ZONES, 200);
    expect(result.map((z) => z.id)).toEqual(["main-gate", "accra-mall", "commonwealth"]);
    expect(result.map((z) => z.id)).not.toContain("legon-hall");
  });

  it("returns an empty array when nothing is within range", () => {
    // Far from campus entirely.
    const result = zonesWithinRadius(0, 0, ZONES, 1000);
    expect(result).toEqual([]);
  });
});

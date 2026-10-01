import { describe, expect, it } from "vitest";
import { SERVICE_AREA_RADIUS_METERS, isOutsideServiceArea, zoneInServiceArea } from "./serviceArea";

const zones = [
  { id: "balme", latitude: 5.6533, longitude: -0.1874 },
  { id: "gate", latitude: 5.6502, longitude: -0.1862 },
];

describe("service area", () => {
  it("is 2 km", () => {
    expect(SERVICE_AREA_RADIUS_METERS).toBe(2_000);
  });

  it("gives the nearest zone on and near campus", () => {
    expect(zoneInServiceArea({ latitude: 5.6534, longitude: -0.1873 }, zones)?.id).toBe("balme");
    expect(zoneInServiceArea({ latitude: 5.67, longitude: -0.1874 }, zones)?.id).toBe("balme"); // ~1.8 km north
  });

  it("gives no zone 122 km away (the off-campus tester) or just past 2 km", () => {
    expect(zoneInServiceArea({ latitude: 6.6885, longitude: -1.6244 }, zones)).toBeNull(); // Kumasi
    expect(zoneInServiceArea({ latitude: 5.6725, longitude: -0.1874 }, zones)).toBeNull(); // ~2.1 km
    expect(isOutsideServiceArea({ latitude: 6.6885, longitude: -1.6244 }, zones)).toBe(true);
  });

  it("doesn't call anyone outside before it knows where they are or where campus is", () => {
    expect(isOutsideServiceArea(null, zones)).toBe(false);
    expect(isOutsideServiceArea({ latitude: 6.6885, longitude: -1.6244 }, [])).toBe(false);
  });
});

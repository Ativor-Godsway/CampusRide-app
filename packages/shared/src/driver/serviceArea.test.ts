import { describe, expect, it } from "vitest";
import { isOutsideServiceArea, zoneInServiceArea } from "./serviceArea";

const zones = [
  { id: "balme", latitude: 5.6533, longitude: -0.1874 },
  { id: "gate", latitude: 5.6502, longitude: -0.1862 },
];

describe("driver service area", () => {
  it("gives the nearest zone anywhere inside the area", () => {
    expect(zoneInServiceArea({ latitude: 5.6534, longitude: -0.1873 }, zones)?.id).toBe("balme");
    // UG Medical Centre, the campus's far south: ~2 km from these zones, but inside the area.
    expect(zoneInServiceArea({ latitude: 5.631864, longitude: -0.185925 }, zones)?.id).toBe("gate");
  });

  it("gives no zone 122 km away (the off-campus tester) or just past the edge", () => {
    expect(zoneInServiceArea({ latitude: 6.6885, longitude: -1.6244 }, zones)).toBeNull(); // Kumasi
    expect(zoneInServiceArea({ latitude: 5.67633, longitude: -0.1779 }, zones)).toBeNull(); // Madina Zongo
    expect(zoneInServiceArea({ latitude: 5.62218, longitude: -0.17326 }, zones)).toBeNull(); // Accra Mall (off campus)
    expect(zoneInServiceArea({ latitude: 5.65035, longitude: -0.17971 }, zones)).toBeNull(); // J.J. Rawlings Avenue at the main gate
    expect(zoneInServiceArea({ latitude: 5.651852, longitude: -0.178107 }, zones)).toBeNull(); // UG Hospital, east of the Avenue
    expect(isOutsideServiceArea({ latitude: 6.6885, longitude: -1.6244 }, zones)).toBe(true);
  });

  it("doesn't call anyone outside before it knows where they are or where campus is", () => {
    expect(isOutsideServiceArea(null, zones)).toBe(false);
    expect(isOutsideServiceArea({ latitude: 6.6885, longitude: -1.6244 }, [])).toBe(false);
  });
});

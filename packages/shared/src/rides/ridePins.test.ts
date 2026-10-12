import { describe, expect, it } from "vitest";
import { PICKUP_NOTE_MAX_LENGTH, dropoffPin, parsePickupNote, pickupPin, stopLabel, stopPoint } from "./ridePins";

const zone = { latitude: 5.65, longitude: -0.18 };

describe("ride pins", () => {
  it("reads a pin when both coordinates are there", () => {
    expect(pickupPin({ pickupLat: 5.6, pickupLng: -0.1 })).toEqual({ latitude: 5.6, longitude: -0.1 });
    expect(dropoffPin({ dropoffLat: 5.7, dropoffLng: -0.2 })).toEqual({ latitude: 5.7, longitude: -0.2 });
    expect(pickupPin({ pickupLat: 5.6, pickupLng: null })).toBeNull();
    expect(pickupPin({})).toBeNull();
  });

  it("falls back to the zone centre and name for a ride without pins (old app builds)", () => {
    expect(stopPoint(null, zone)).toEqual(zone);
    expect(stopPoint({ latitude: 1, longitude: 2 }, zone)).toEqual({ latitude: 1, longitude: 2 });
    expect(stopLabel(null, "Main Gate")).toBe("Main Gate");
    expect(stopLabel("  ", "Main Gate")).toBe("Main Gate");
    expect(stopLabel("Night Market", "Main Gate")).toBe("Night Market");
  });

  it("parses the note for the driver", () => {
    expect(parsePickupNote(undefined)).toEqual({ ok: true, note: null });
    expect(parsePickupNote("   ")).toEqual({ ok: true, note: null });
    expect(parsePickupNote("  At the  main gate,\nblue shirt ")).toEqual({ ok: true, note: "At the main gate, blue shirt" });
    expect(parsePickupNote("x".repeat(PICKUP_NOTE_MAX_LENGTH)).ok).toBe(true);
    expect(parsePickupNote("x".repeat(PICKUP_NOTE_MAX_LENGTH + 1)).ok).toBe(false);
    expect(parsePickupNote(42).ok).toBe(false);
  });
});

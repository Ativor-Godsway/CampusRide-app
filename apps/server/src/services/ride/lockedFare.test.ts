import { describe, it, expect } from "vitest";
import { recomputeLockedFares, type LockedFarePassenger } from "./lockedFare";

// Flat SHARED pricing: getSharedFarePerRider always returns 500 regardless
// of occupancy, so the JOIN branch's "newRate" is invariant — the ratchet
// mechanism stays in place (kept, not deleted) but self-neutralizes: every
// active passenger is already at 500, so Math.min(500, 500) is always 500.
// These tests assert that invariant directly rather than a downward climb.

describe("recomputeLockedFares — JOIN stays at 500 (flat pricing, no ratchet)", () => {
  it("1 -> 2: both passengers stay at 500", () => {
    const passengers: LockedFarePassenger[] = [
      { id: "a", status: "WAITING", lockedFare: 500 },
      { id: "b", status: "WAITING", lockedFare: 500 }, // newly joined, pre-recompute
    ];

    const result = recomputeLockedFares(passengers, { type: "JOIN" });

    expect(result.find((p) => p.id === "a")?.lockedFare).toBe(500);
    expect(result.find((p) => p.id === "b")?.lockedFare).toBe(500);
  });

  it("2 -> 3: all three passengers stay at 500", () => {
    const passengers: LockedFarePassenger[] = [
      { id: "a", status: "WAITING", lockedFare: 500 },
      { id: "b", status: "WAITING", lockedFare: 500 },
      { id: "c", status: "WAITING", lockedFare: 500 }, // newly joined
    ];

    const result = recomputeLockedFares(passengers, { type: "JOIN" });

    for (const p of result) {
      expect(p.lockedFare).toBe(500);
    }
  });

  it("full join sequence 1 -> 2 -> 3 -> 4 never moves off 500", () => {
    let passengers: LockedFarePassenger[] = [
      { id: "a", status: "WAITING", lockedFare: 500 },
    ];
    expect(passengers[0]!.lockedFare).toBe(500);

    // B joins
    passengers = recomputeLockedFares(
      [...passengers, { id: "b", status: "WAITING", lockedFare: 500 }],
      { type: "JOIN" },
    );
    expect(passengers.map((p) => p.lockedFare)).toEqual([500, 500]);

    // C joins
    passengers = recomputeLockedFares(
      [...passengers, { id: "c", status: "WAITING", lockedFare: 500 }],
      { type: "JOIN" },
    );
    expect(passengers.map((p) => p.lockedFare)).toEqual([500, 500, 500]);

    // D joins (full car)
    passengers = recomputeLockedFares(
      [...passengers, { id: "d", status: "WAITING", lockedFare: 500 }],
      { type: "JOIN" },
    );
    expect(passengers.map((p) => p.lockedFare)).toEqual([500, 500, 500, 500]);
  });

  it("Math.min guard still clamps a stale higher rate down to 500, never up", () => {
    const passengers: LockedFarePassenger[] = [
      { id: "a", status: "WAITING", lockedFare: 500 }, // already at the flat rate
      { id: "b", status: "WAITING", lockedFare: 1000 }, // stale pre-migration value
    ];

    // newRate is always 500 now — "b"'s stale 1000 gets clamped down on the
    // next join; "a" was already correct and stays put. Confirms the
    // ratchet self-heals any pre-existing non-flat lockedFare without ever
    // raising one.
    const result = recomputeLockedFares(passengers, { type: "JOIN" });

    expect(result.find((p) => p.id === "a")?.lockedFare).toBe(500);
    expect(result.find((p) => p.id === "b")?.lockedFare).toBe(500);
  });

  it("ignores DROPPED_OFF/CANCELLED passengers — inactive lockedFare left untouched", () => {
    const passengers: LockedFarePassenger[] = [
      { id: "a", status: "WAITING", lockedFare: 500 },
      { id: "b", status: "CANCELLED", lockedFare: 1000 }, // stale, inactive
      { id: "c", status: "WAITING", lockedFare: 500 }, // newly joined
    ];

    const result = recomputeLockedFares(passengers, { type: "JOIN" });

    expect(result.find((p) => p.id === "a")?.lockedFare).toBe(500);
    expect(result.find((p) => p.id === "c")?.lockedFare).toBe(500);
    // Inactive passenger's lockedFare is left untouched, even if stale.
    expect(result.find((p) => p.id === "b")?.lockedFare).toBe(1000);
  });
});

describe("recomputeLockedFares — CANCEL never changes remaining fares", () => {
  it("3 -> 2 (one cancels): remaining passengers stay at 500", () => {
    const passengers: LockedFarePassenger[] = [
      { id: "a", status: "WAITING", lockedFare: 500 },
      { id: "b", status: "WAITING", lockedFare: 500 },
      { id: "c", status: "CANCELLED", lockedFare: 500 },
    ];

    const result = recomputeLockedFares(passengers, { type: "CANCEL" });

    expect(result.find((p) => p.id === "a")?.lockedFare).toBe(500);
    expect(result.find((p) => p.id === "b")?.lockedFare).toBe(500);
  });
});

describe("recomputeLockedFares — DEPARTURE freezes fares", () => {
  it("returns passengers unchanged", () => {
    const passengers: LockedFarePassenger[] = [
      { id: "a", status: "PICKED_UP", lockedFare: 500 },
      { id: "b", status: "PICKED_UP", lockedFare: 500 },
    ];

    const result = recomputeLockedFares(passengers, { type: "DEPARTURE" });

    expect(result).toEqual(passengers);
  });
});

describe("recomputeLockedFares — purity", () => {
  it("does not mutate the input array or its elements", () => {
    const passengers: LockedFarePassenger[] = [
      { id: "a", status: "WAITING", lockedFare: 500 },
      { id: "b", status: "WAITING", lockedFare: 500 },
    ];
    const snapshot = JSON.parse(JSON.stringify(passengers));

    recomputeLockedFares(passengers, { type: "JOIN" });

    expect(passengers).toEqual(snapshot);
  });
});

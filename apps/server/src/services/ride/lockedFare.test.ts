import { describe, it, expect } from "vitest";
import { recomputeLockedFares, type LockedFarePassenger } from "./lockedFare";

// Flat SHARED pricing: getSharedFarePerRider always returns 700 regardless
// of occupancy, so the JOIN branch's "newRate" is invariant — the ratchet
// mechanism stays in place (kept, not deleted) but self-neutralizes: every
// active passenger is already at 700, so Math.min(700, 700) is always 700.
// These tests assert that invariant directly rather than a downward climb.

describe("recomputeLockedFares — JOIN stays at 700 (flat pricing, no ratchet)", () => {
  it("1 -> 2: both passengers stay at 700", () => {
    const passengers: LockedFarePassenger[] = [
      { id: "a", status: "WAITING", lockedFare: 700 },
      { id: "b", status: "WAITING", lockedFare: 700 }, // newly joined, pre-recompute
    ];

    const result = recomputeLockedFares(passengers, { type: "JOIN" });

    expect(result.find((p) => p.id === "a")?.lockedFare).toBe(700);
    expect(result.find((p) => p.id === "b")?.lockedFare).toBe(700);
  });

  it("2 -> 3: all three passengers stay at 700", () => {
    const passengers: LockedFarePassenger[] = [
      { id: "a", status: "WAITING", lockedFare: 700 },
      { id: "b", status: "WAITING", lockedFare: 700 },
      { id: "c", status: "WAITING", lockedFare: 700 }, // newly joined
    ];

    const result = recomputeLockedFares(passengers, { type: "JOIN" });

    for (const p of result) {
      expect(p.lockedFare).toBe(700);
    }
  });

  it("full join sequence 1 -> 2 -> 3 -> 4 never moves off 700", () => {
    let passengers: LockedFarePassenger[] = [
      { id: "a", status: "WAITING", lockedFare: 700 },
    ];
    expect(passengers[0]!.lockedFare).toBe(700);

    // B joins
    passengers = recomputeLockedFares(
      [...passengers, { id: "b", status: "WAITING", lockedFare: 700 }],
      { type: "JOIN" },
    );
    expect(passengers.map((p) => p.lockedFare)).toEqual([700, 700]);

    // C joins
    passengers = recomputeLockedFares(
      [...passengers, { id: "c", status: "WAITING", lockedFare: 700 }],
      { type: "JOIN" },
    );
    expect(passengers.map((p) => p.lockedFare)).toEqual([700, 700, 700]);

    // D joins (full car)
    passengers = recomputeLockedFares(
      [...passengers, { id: "d", status: "WAITING", lockedFare: 700 }],
      { type: "JOIN" },
    );
    expect(passengers.map((p) => p.lockedFare)).toEqual([700, 700, 700, 700]);
  });

  it("Math.min guard still clamps a stale higher rate down to 700, never up", () => {
    const passengers: LockedFarePassenger[] = [
      { id: "a", status: "WAITING", lockedFare: 700 }, // already at the flat rate
      { id: "b", status: "WAITING", lockedFare: 1000 }, // stale pre-migration value
    ];

    // newRate is always 700 now — "b"'s stale 1000 gets clamped down on the
    // next join; "a" was already correct and stays put. Confirms the
    // ratchet self-heals any pre-existing non-flat lockedFare without ever
    // raising one.
    const result = recomputeLockedFares(passengers, { type: "JOIN" });

    expect(result.find((p) => p.id === "a")?.lockedFare).toBe(700);
    expect(result.find((p) => p.id === "b")?.lockedFare).toBe(700);
  });

  it("ignores DROPPED_OFF/CANCELLED passengers — inactive lockedFare left untouched", () => {
    const passengers: LockedFarePassenger[] = [
      { id: "a", status: "WAITING", lockedFare: 700 },
      { id: "b", status: "CANCELLED", lockedFare: 1000 }, // stale, inactive
      { id: "c", status: "WAITING", lockedFare: 700 }, // newly joined
    ];

    const result = recomputeLockedFares(passengers, { type: "JOIN" });

    expect(result.find((p) => p.id === "a")?.lockedFare).toBe(700);
    expect(result.find((p) => p.id === "c")?.lockedFare).toBe(700);
    // Inactive passenger's lockedFare is left untouched, even if stale.
    expect(result.find((p) => p.id === "b")?.lockedFare).toBe(1000);
  });
});

describe("recomputeLockedFares — a price rise never reaches a booked seat", () => {
  it("riders booked at the old GH₵5 keep it when someone joins at GH₵7", () => {
    const result = recomputeLockedFares(
      [
        { id: "a", status: "WAITING", lockedFare: 500 }, // booked before the change
        { id: "b", status: "PICKED_UP", lockedFare: 500 },
        { id: "c", status: "WAITING", lockedFare: 700 }, // newly joined at today's price
      ],
      { type: "JOIN" },
    );
    expect(result.map((p) => p.lockedFare)).toEqual([500, 500, 700]);
  });
});

describe("recomputeLockedFares — CANCEL never changes remaining fares", () => {
  it("3 -> 2 (one cancels): remaining passengers stay at 700", () => {
    const passengers: LockedFarePassenger[] = [
      { id: "a", status: "WAITING", lockedFare: 700 },
      { id: "b", status: "WAITING", lockedFare: 700 },
      { id: "c", status: "CANCELLED", lockedFare: 700 },
    ];

    const result = recomputeLockedFares(passengers, { type: "CANCEL" });

    expect(result.find((p) => p.id === "a")?.lockedFare).toBe(700);
    expect(result.find((p) => p.id === "b")?.lockedFare).toBe(700);
  });
});

describe("recomputeLockedFares — DEPARTURE freezes fares", () => {
  it("returns passengers unchanged", () => {
    const passengers: LockedFarePassenger[] = [
      { id: "a", status: "PICKED_UP", lockedFare: 700 },
      { id: "b", status: "PICKED_UP", lockedFare: 700 },
    ];

    const result = recomputeLockedFares(passengers, { type: "DEPARTURE" });

    expect(result).toEqual(passengers);
  });
});

describe("recomputeLockedFares — purity", () => {
  it("does not mutate the input array or its elements", () => {
    const passengers: LockedFarePassenger[] = [
      { id: "a", status: "WAITING", lockedFare: 700 },
      { id: "b", status: "WAITING", lockedFare: 700 },
    ];
    const snapshot = JSON.parse(JSON.stringify(passengers));

    recomputeLockedFares(passengers, { type: "JOIN" });

    expect(passengers).toEqual(snapshot);
  });
});

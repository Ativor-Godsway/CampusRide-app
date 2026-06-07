import { describe, it, expect } from "vitest";
import { recomputeLockedFares, type LockedFarePassenger } from "./lockedFare";

describe("recomputeLockedFares — JOIN ratchets fares downward", () => {
  it("1 -> 2: both passengers ratchet from 1000 to 700", () => {
    const passengers: LockedFarePassenger[] = [
      { id: "a", status: "WAITING", lockedFare: 1000 },
      { id: "b", status: "WAITING", lockedFare: 1000 }, // newly joined, pre-recompute
    ];

    const result = recomputeLockedFares(passengers, { type: "JOIN" });

    expect(result.find((p) => p.id === "a")?.lockedFare).toBe(700);
    expect(result.find((p) => p.id === "b")?.lockedFare).toBe(700);
  });

  it("2 -> 3: all three passengers ratchet from 700 to 600", () => {
    const passengers: LockedFarePassenger[] = [
      { id: "a", status: "WAITING", lockedFare: 700 },
      { id: "b", status: "WAITING", lockedFare: 700 },
      { id: "c", status: "WAITING", lockedFare: 700 }, // newly joined
    ];

    const result = recomputeLockedFares(passengers, { type: "JOIN" });

    for (const p of result) {
      expect(p.lockedFare).toBe(600);
    }
  });

  it("full join sequence 1 -> 2 -> 3 ratchets 1000 -> 700 -> 600", () => {
    let passengers: LockedFarePassenger[] = [
      { id: "a", status: "WAITING", lockedFare: 1000 },
    ];
    expect(passengers[0]!.lockedFare).toBe(1000);

    // B joins
    passengers = recomputeLockedFares(
      [...passengers, { id: "b", status: "WAITING", lockedFare: 1000 }],
      { type: "JOIN" },
    );
    expect(passengers.map((p) => p.lockedFare)).toEqual([700, 700]);

    // C joins
    passengers = recomputeLockedFares(
      [...passengers, { id: "c", status: "WAITING", lockedFare: 700 }],
      { type: "JOIN" },
    );
    expect(passengers.map((p) => p.lockedFare)).toEqual([600, 600, 600]);
  });

  it("never raises a fare (Math.min guard) even if a stale higher rate is passed", () => {
    const passengers: LockedFarePassenger[] = [
      { id: "a", status: "WAITING", lockedFare: 500 }, // already at the lowest rate
      { id: "b", status: "WAITING", lockedFare: 1000 },
    ];

    // activeCount = 2 -> newRate = 700, but "a" must stay at 500
    const result = recomputeLockedFares(passengers, { type: "JOIN" });

    expect(result.find((p) => p.id === "a")?.lockedFare).toBe(500);
    expect(result.find((p) => p.id === "b")?.lockedFare).toBe(700);
  });

  it("ignores DROPPED_OFF/CANCELLED passengers when computing the new rate", () => {
    const passengers: LockedFarePassenger[] = [
      { id: "a", status: "WAITING", lockedFare: 1000 },
      { id: "b", status: "CANCELLED", lockedFare: 1000 },
      { id: "c", status: "WAITING", lockedFare: 1000 }, // newly joined
    ];

    // Active count is 2 (a, c) — not 3 — so rate is 700, not 600.
    const result = recomputeLockedFares(passengers, { type: "JOIN" });

    expect(result.find((p) => p.id === "a")?.lockedFare).toBe(700);
    expect(result.find((p) => p.id === "c")?.lockedFare).toBe(700);
    // Inactive passenger's lockedFare is left untouched.
    expect(result.find((p) => p.id === "b")?.lockedFare).toBe(1000);
  });
});

describe("recomputeLockedFares — CANCEL never raises remaining fares", () => {
  it("3 -> 2 (one cancels): remaining passengers stay at 600, not raised to 700", () => {
    const passengers: LockedFarePassenger[] = [
      { id: "a", status: "WAITING", lockedFare: 600 },
      { id: "b", status: "WAITING", lockedFare: 600 },
      { id: "c", status: "CANCELLED", lockedFare: 600 },
    ];

    const result = recomputeLockedFares(passengers, { type: "CANCEL" });

    expect(result.find((p) => p.id === "a")?.lockedFare).toBe(600);
    expect(result.find((p) => p.id === "b")?.lockedFare).toBe(600);
  });
});

describe("recomputeLockedFares — DEPARTURE freezes fares", () => {
  it("returns passengers unchanged", () => {
    const passengers: LockedFarePassenger[] = [
      { id: "a", status: "PICKED_UP", lockedFare: 600 },
      { id: "b", status: "PICKED_UP", lockedFare: 600 },
    ];

    const result = recomputeLockedFares(passengers, { type: "DEPARTURE" });

    expect(result).toEqual(passengers);
  });
});

describe("recomputeLockedFares — purity", () => {
  it("does not mutate the input array or its elements", () => {
    const passengers: LockedFarePassenger[] = [
      { id: "a", status: "WAITING", lockedFare: 1000 },
      { id: "b", status: "WAITING", lockedFare: 1000 },
    ];
    const snapshot = JSON.parse(JSON.stringify(passengers));

    recomputeLockedFares(passengers, { type: "JOIN" });

    expect(passengers).toEqual(snapshot);
  });
});

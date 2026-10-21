import { describe, expect, it } from "vitest";
import { todayEarnings } from "./todayEarnings";

// Local times, so the tests mean the same in any time zone.
const now = new Date(2026, 9, 21, 18, 0);
const iso = (y: number, mo: number, d: number, h: number) => new Date(y, mo, d, h).toISOString();

describe("todayEarnings", () => {
  it("adds up today's completed trips only", () => {
    const trips = [
      { completedAt: iso(2026, 9, 21, 17), driverGrossPesewas: 425 },
      { completedAt: iso(2026, 9, 21, 0), driverGrossPesewas: 1325 },
      { completedAt: iso(2026, 9, 20, 23), driverGrossPesewas: 999 },
      { completedAt: iso(2025, 9, 21, 12), driverGrossPesewas: 999 },
    ];
    expect(todayEarnings(trips, now)).toEqual({ pesewas: 1750, trips: 2 });
  });

  it("is nothing on a day without trips", () => {
    expect(todayEarnings([], now)).toEqual({ pesewas: 0, trips: 0 });
  });
});

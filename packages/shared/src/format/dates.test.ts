import { describe, expect, it } from "vitest";
import { clockTime, dayLabel, groupByDay } from "./dates";

// Local times, so the tests mean the same in any time zone.
const now = new Date(2026, 9, 21, 9, 30); // Wed 21 Oct 2026

describe("clockTime", () => {
  it("is 12-hour with AM/PM", () => {
    expect(clockTime(new Date(2026, 9, 21, 18, 47))).toBe("6:47 PM");
    expect(clockTime(new Date(2026, 9, 21, 0, 5))).toBe("12:05 AM");
    expect(clockTime(new Date(2026, 9, 21, 12, 0))).toBe("12:00 PM");
  });
});

describe("dayLabel", () => {
  it("says Today, Yesterday, then the weekday and date", () => {
    expect(dayLabel(new Date(2026, 9, 21, 0, 1), now)).toBe("Today");
    expect(dayLabel(new Date(2026, 9, 20, 23, 59), now)).toBe("Yesterday");
    expect(dayLabel(new Date(2026, 9, 19, 18, 36), now)).toBe("Mon 19 Oct");
    expect(dayLabel(new Date(2025, 11, 19, 8, 0), now)).toBe("Fri 19 Dec 2025");
  });

  it("knows yesterday across a month", () => {
    expect(dayLabel(new Date(2026, 9, 31, 20, 0), new Date(2026, 10, 1, 8, 0))).toBe("Yesterday");
  });
});

describe("groupByDay", () => {
  it("keeps the order and starts a group at each new day", () => {
    const rides = [
      { id: "a", at: new Date(2026, 9, 21, 8) },
      { id: "b", at: new Date(2026, 9, 21, 7) },
      { id: "c", at: new Date(2026, 9, 19, 18) },
    ];
    expect(
      groupByDay(rides, (r) => r.at, now).map((g) => [g.label, g.items.map((r) => r.id)]),
    ).toEqual([
      ["Today", ["a", "b"]],
      ["Mon 19 Oct", ["c"]],
    ]);
  });
});

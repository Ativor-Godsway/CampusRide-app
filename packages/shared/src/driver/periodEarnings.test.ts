import { describe, expect, it } from "vitest";
import { periodEarnings, weekEarnings } from "./periodEarnings";

// Local times, so the tests mean the same in any time zone. Wed 21 Oct 2026.
const now = new Date(2026, 9, 21, 18, 0);
const trip = (d: number, h: number, face: number) => ({
  completedAt: new Date(2026, 9, d, h).toISOString(),
  facePesewas: face,
  driverGrossPesewas: Math.round(face * 0.85),
});

describe("weekEarnings", () => {
  it("runs Monday to Sunday with today marked", () => {
    const days = weekEarnings([], now);
    expect(days.map((d) => d.label)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    expect(days.findIndex((d) => d.isToday)).toBe(2);
    expect(new Date(days[0]!.start).getDate()).toBe(19);
  });

  it("puts each trip on its day, after the 15% commission", () => {
    const days = weekEarnings(
      [trip(21, 9, 1500), trip(21, 17, 500), trip(19, 8, 500), trip(18, 23, 500)],
      now,
    );
    expect(days[2]).toMatchObject({
      trips: 2,
      grossPesewas: 1700,
      commissionPesewas: 300,
      netPesewas: 1400,
    });
    expect(days[0]).toMatchObject({ trips: 1, netPesewas: 350 });
  });

  it("a Sunday belongs to the week that started the Monday before", () => {
    const sunday = new Date(2026, 9, 25, 12);
    expect(weekEarnings([], sunday).find((d) => d.isToday)?.label).toBe("Sun");
    expect(new Date(weekEarnings([], sunday)[0]!.start).getDate()).toBe(19);
  });
});

describe("periodEarnings", () => {
  it("today and this week", () => {
    const trips = [trip(21, 9, 1500), trip(20, 9, 500), trip(12, 9, 500)];
    expect(periodEarnings(trips, "today", now)).toEqual({
      trips: 1,
      grossPesewas: 1275,
      commissionPesewas: 225,
      netPesewas: 1050,
    });
    expect(periodEarnings(trips, "week", now).trips).toBe(2);
  });
});

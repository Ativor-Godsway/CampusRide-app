import { describe, expect, it } from "vitest";
import { splitFare } from "../pricing/pricing";
import { earningsTotals, periodEarnings, weekEarnings } from "./periodEarnings";
import { todayEarnings } from "./todayEarnings";

// Local times, so the tests mean the same in any time zone. Wed 21 Oct 2026.
const now = new Date(2026, 9, 21, 18, 0);
/** A completed trip as GET /driver/rides/history sends it: the fare and the driver's 85% share. */
const trip = (d: number, h: number, fare: number) => ({
  completedAt: new Date(2026, 9, d, h).toISOString(),
  facePesewas: fare,
  driverGrossPesewas: splitFare(fare).driverShare,
});

// The owner's example: a GH₵5 shared trip and a GH₵15 private trip today.
const shared = trip(21, 9, 500); // You earn GH₵4.25
const lone = trip(21, 17, 1500); // You earn GH₵12.75

describe("earningsTotals: the one rule", () => {
  it("gross is the fares, commission 15% of them, after commission the sum of 'You earn'", () => {
    expect(earningsTotals([shared, lone])).toEqual({
      trips: 2,
      grossPesewas: 2000,
      commissionPesewas: 300,
      netPesewas: 1700,
    });
  });

  it("takes the commission out once: after commission is 85% of gross, not 70%", () => {
    const t = earningsTotals([shared, lone, trip(20, 8, 1000)]);
    expect(t.netPesewas).toBe(t.grossPesewas - t.commissionPesewas);
    expect(t.netPesewas).toBe(
      shared.driverGrossPesewas + lone.driverGrossPesewas + splitFare(1000).driverShare,
    );
    expect(t.commissionPesewas).toBe(Math.round(t.grossPesewas * 0.15));
  });

  it("is nothing for no trips", () => {
    expect(earningsTotals([])).toEqual({
      trips: 0,
      grossPesewas: 0,
      commissionPesewas: 0,
      netPesewas: 0,
    });
  });
});

describe("weekEarnings", () => {
  it("runs Monday to Sunday with today marked", () => {
    const days = weekEarnings([], now);
    expect(days.map((d) => d.label)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    expect(days.findIndex((d) => d.isToday)).toBe(2);
    expect(new Date(days[0]!.start).getDate()).toBe(19);
  });

  it("puts each trip on its day, by the same rule", () => {
    const days = weekEarnings([shared, lone, trip(19, 8, 500), trip(18, 23, 500)], now);
    expect(days[2]).toMatchObject({
      trips: 2,
      grossPesewas: 2000,
      commissionPesewas: 300,
      netPesewas: 1700,
    });
    expect(days[0]).toMatchObject({ trips: 1, grossPesewas: 500, netPesewas: 425 });
  });

  it("a Sunday belongs to the week that started the Monday before", () => {
    const sunday = new Date(2026, 9, 25, 12);
    expect(weekEarnings([], sunday).find((d) => d.isToday)?.label).toBe("Sun");
    expect(new Date(weekEarnings([], sunday)[0]!.start).getDate()).toBe(19);
  });
});

describe("periodEarnings", () => {
  const trips = [shared, lone, trip(20, 9, 500), trip(12, 9, 500)];

  it("Today is the owner's example: 20 / −3 / 17", () => {
    expect(periodEarnings(trips, "today", now)).toEqual({
      trips: 2,
      grossPesewas: 2000,
      commissionPesewas: 300,
      netPesewas: 1700,
    });
  });

  it("This week adds the days the same way", () => {
    const week = periodEarnings(trips, "week", now);
    expect(week).toEqual(earningsTotals([shared, lone, trips[2]!]));
    expect(week.netPesewas).toBe(1700 + 425);
  });
});

describe("todayEarnings: Home pill and trip-complete card", () => {
  it("is the Earnings tab's Today, after commission", () => {
    const trips = [shared, lone, trip(20, 9, 500)];
    expect(todayEarnings(trips, now)).toEqual({ pesewas: 1700, trips: 2 });
    expect(todayEarnings(trips, now).pesewas).toBe(periodEarnings(trips, "today", now).netPesewas);
  });

  it("ignores other days and years", () => {
    expect(
      todayEarnings(
        [trip(20, 23, 500), { ...shared, completedAt: new Date(2025, 9, 21, 12).toISOString() }],
        now,
      ),
    ).toEqual({
      pesewas: 0,
      trips: 0,
    });
  });
});

/**
 * The admin dashboard's definitions (docs/admin-metrics.md), as arithmetic:
 * medians, sessions clipped to a period (spanning midnight), acceptance
 * rate, the verdict rule and its suggestion line, Accra time buckets, and
 * the 60-second cache.
 */
import { describe, expect, it } from "vitest";
import {
  acceptance,
  clippedMs,
  driversNeeded,
  driversOnlineByHour,
  hourRangeLabel,
  median,
  onlineMsByHourOfDay,
  ratio,
  supplySuggestion,
  verdictWindowLabel,
  verdictWindowOf,
  zoneVerdicts,
  type VerdictRequest,
} from "./metrics";
import { accraDay, accraHour, accraWeekday, daysIn, parsePeriod, startOfAccraDay, weekEarlier } from "./period";
import { cached, clearAdminCache } from "./cache";
import { paymentStatus } from "./cash";

const H = 60 * 60_000;
// Monday 7 January 2030, midnight in Accra (= UTC).
const MON = Date.parse("2030-01-07T00:00:00.000Z");
const at = (dayOffset: number, hour: number, minute = 0) => new Date(MON + dayOffset * 24 * H + hour * H + minute * 60_000);
const week = { from: new Date(MON), to: new Date(MON + 7 * 24 * H) };

describe("median and ratio", () => {
  it("median of odd, even and empty lists", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });
  it("a zero denominator is no answer, not 0%", () => {
    expect(ratio(0, 0)).toBeNull();
    expect(ratio(1, 4)).toBe(0.25);
  });
});

describe("Accra time", () => {
  it("is GMT: hours, weekdays (Monday first) and days read straight from UTC", () => {
    expect(accraHour(new Date("2030-01-07T18:30:00Z"))).toBe(18);
    expect(accraWeekday(new Date("2030-01-07T23:59:00Z"))).toBe(0);
    expect(accraWeekday(new Date("2030-01-13T12:00:00Z"))).toBe(6);
    expect(accraDay(new Date("2030-01-07T23:59:59Z"))).toBe("2030-01-07");
    expect(startOfAccraDay("2030-01-07")!.toISOString()).toBe("2030-01-07T00:00:00.000Z");
    expect(startOfAccraDay("7 Jan")).toBeNull();
  });
  it("periods are checked, compared a week earlier, and list their days", () => {
    expect(parsePeriod({ from: "x", to: "y" })).toHaveProperty("error");
    expect(parsePeriod({ from: week.to.toISOString(), to: week.from.toISOString() })).toHaveProperty("error");
    expect(parsePeriod({ from: "2020-01-01T00:00:00Z", to: "2030-01-01T00:00:00Z" })).toHaveProperty("error");
    expect(weekEarlier(week).from.toISOString()).toBe("2029-12-31T00:00:00.000Z");
    expect(daysIn(week)).toHaveLength(7);
  });
});

describe("hours online", () => {
  it("clips a session spanning midnight to the period, and counts an open one up to now", () => {
    const monday = { from: at(0, 0), to: at(1, 0) };
    const lateShift = { driverUserId: "d", startedAt: at(0, 22), endedAt: at(1, 2) };
    expect(clippedMs(lateShift, monday, at(3, 0))).toBe(2 * H);
    expect(clippedMs(lateShift, { from: at(1, 0), to: at(2, 0) }, at(3, 0))).toBe(2 * H);
    const open = { driverUserId: "d", startedAt: at(0, 10), endedAt: null };
    expect(clippedMs(open, monday, at(0, 13))).toBe(3 * H);
    expect(clippedMs(open, { from: at(5, 0), to: at(6, 0) }, at(0, 13))).toBe(0);
  });

  it("spreads driver-hours over the hours of the day, and counts distinct drivers per hour", () => {
    const sessions = [
      { driverUserId: "a", startedAt: at(0, 17, 30), endedAt: at(0, 19) },
      { driverUserId: "a", startedAt: at(1, 17), endedAt: at(1, 18) },
      { driverUserId: "b", startedAt: at(0, 18), endedAt: at(0, 18, 15) },
    ];
    const ms = onlineMsByHourOfDay(sessions, week, at(9, 0));
    expect(ms[17]).toBe(0.5 * H + H);
    expect(ms[18]).toBe(H + 0.25 * H);
    expect(ms.reduce((s, x) => s + x, 0)).toBe(1.5 * H + H + 0.25 * H);
    const monday = driversOnlineByHour(sessions, { from: at(0, 0), to: at(1, 0) }, at(9, 0));
    expect(monday[17]).toBe(1);
    expect(monday[18]).toBe(2);
    expect(monday[19]).toBe(0);
  });
});

describe("acceptance rate", () => {
  it("counts accepted ÷ (accepted + declined + timed out); taken, cancelled, expired and open don't count", () => {
    const o = (outcome: "ACCEPTED" | "DECLINED" | "TIMED_OUT" | "TAKEN" | "CANCELLED" | "EXPIRED" | null, replyS: number | null) => ({
      outcome,
      offeredAt: at(0, 9),
      decidedAt: replyS === null ? null : new Date(at(0, 9).getTime() + replyS * 1000),
    });
    const result = acceptance([o("ACCEPTED", 4), o("ACCEPTED", 6), o("DECLINED", 2), o("TIMED_OUT", 15), o("TAKEN", 8), o("CANCELLED", 3), o("EXPIRED", 90), o(null, null)]);
    expect(result).toMatchObject({ offers: 8, accepted: 2, declined: 1, timedOut: 1 });
    expect(result.rate).toBe(0.5);
    // Replies: 4, 6 and 2 seconds (a time-out isn't a reply).
    expect(result.avgReplyMs).toBe(4000);
    expect(acceptance([o("TAKEN", 1)]).rate).toBeNull();
  });
});

describe("the verdict rule", () => {
  it("windows start at 7 am, three hours each, with readable labels", () => {
    expect(verdictWindowOf(7)).toBe(0);
    expect(verdictWindowOf(17)).toBe(3);
    expect(verdictWindowOf(23)).toBe(5);
    expect(verdictWindowOf(0)).toBe(5);
    expect(verdictWindowOf(6)).toBe(7);
    expect(verdictWindowLabel(3)).toBe("4–7 pm");
    expect(verdictWindowLabel(1)).toBe("10 am–1 pm");
    expect(verdictWindowLabel(5)).toBe("10 pm–1 am");
    expect(hourRangeLabel(7, 10)).toBe("7–10 am");
  });

  it("N = ceil(no-driver ÷ max(1, trips per driver-hour)), capped at 5", () => {
    expect(driversNeeded(3, 0)).toBe(3);
    expect(driversNeeded(3, 2)).toBe(2);
    expect(driversNeeded(40, 1)).toBe(5);
  });

  const req = (zoneId: string, day: number, hour: number, noDriver: boolean): VerdictRequest => ({ zoneId, createdAt: at(day, hour), noDriver });

  it("needs ≥ 3 requests and ≥ 15% without a driver in a zone-window; else OK", () => {
    const requests = [
      // Night Market, 4–7 pm: 4 requests, 2 without a driver (50%).
      req("market", 4, 17, true), req("market", 5, 18, true), req("market", 4, 16, false), req("market", 1, 17, false),
      // Balme, 4–7 pm: only 2 requests, both missed: too few to judge.
      req("balme", 4, 17, true), req("balme", 5, 17, true),
      // Pent, 7–10 am: 10 requests, 1 missed (10%): under 15%.
      ...Array.from({ length: 9 }, (_, i) => req("pent", i % 5, 8, false)), req("pent", 2, 8, true),
    ];
    // 4–7 pm: 2 driver-hours online and 4 completed trips → 2 trips per driver-hour.
    const onlineMsByHour = new Array<number>(24).fill(0);
    onlineMsByHour[17] = 2 * H;
    const input = { requests, completedTripTimes: [at(0, 16), at(1, 17), at(2, 18), at(3, 17)], onlineMsByHour };
    const verdicts = zoneVerdicts(input);
    expect(verdicts.get("market")).toMatchObject({ need: 1, worst: { label: "4–7 pm", requests: 4, noDriver: 2, tripsPerDriverHour: 2 } });
    expect(verdicts.get("balme")).toMatchObject({ need: 0, worst: null });
    expect(verdicts.get("pent")).toMatchObject({ need: 0 });
    // Campus-wide 4–7 pm: 4 misses (market 2 + balme 2) ÷ 2 per driver-hour = 2 drivers, on Fri and Sat.
    expect(supplySuggestion(input, verdicts)).toBe("Ask 2 more drivers to be online Fri and Sat, 4–7 pm.");
  });

  it("no suggestion when no zone needs drivers", () => {
    const input = { requests: [req("a", 0, 9, false), req("a", 0, 9, false), req("a", 0, 9, false)], completedTripTimes: [], onlineMsByHour: new Array<number>(24).fill(0) };
    expect(supplySuggestion(input, zoneVerdicts(input))).toBeNull();
  });
});

describe("cash status", () => {
  it("Paid when nothing is owed, Part paid when something was paid in the period, else Not paid", () => {
    expect(paymentStatus(0, 0)).toBe("PAID");
    expect(paymentStatus(-100, 0)).toBe("PAID");
    expect(paymentStatus(500, 200)).toBe("PART_PAID");
    expect(paymentStatus(500, 0)).toBe("NOT_PAID");
  });
});

describe("the 60-second cache", () => {
  it("computes once per minute per key, shares a computation in flight, and forgets failures and on clear", async () => {
    clearAdminCache();
    let runs = 0;
    const work = async () => ++runs;
    expect(await cached("k", work, 60_000, 0)).toBe(1);
    expect(await cached("k", work, 60_000, 59_000)).toBe(1);
    expect(await cached("k", work, 60_000, 60_000)).toBe(2);
    const [a, b] = await Promise.all([cached("j", work, 60_000, 0), cached("j", work, 60_000, 1)]);
    expect(a).toBe(b);
    await expect(cached("bad", () => Promise.reject(new Error("db down")), 60_000, 0)).rejects.toThrow();
    expect(await cached("bad", async () => "ok", 60_000, 1)).toBe("ok");
    clearAdminCache();
    expect(await cached("k", work, 60_000, 61_000)).toBe(4);
  });
});

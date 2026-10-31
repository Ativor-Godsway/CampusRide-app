/**
 * Money, Accra time, periods and CSV: the helpers every page leans on.
 */
import { describe, expect, it } from "vitest";
import { cedis, cedisInput, count, parseCedis, percent } from "./money";
import { ago, clock, dayAndTime, duration, hourLabel, hours, mondayOf, shortDay } from "./time";
import { comparisonLabel, customPeriod, periodFromSearch, periodLabel, periodQuery, periodToSearch, presetPeriod } from "./period";
import { csvCell, toCsv } from "./csv";

describe("money", () => {
  it("GH₵ with no space, no decimals for whole cedis, grouped thousands", () => {
    expect(cedis(1500)).toBe("GH₵15");
    expect(cedis(1275)).toBe("GH₵12.75");
    expect(cedis(1050)).toBe("GH₵10.50");
    expect(cedis(121200)).toBe("GH₵1,212");
    expect(cedis(0)).toBe("GH₵0");
    expect(cedis(-300)).toBe("−GH₵3");
    expect(cedis(null)).toBe("—");
  });
  it("reads what an admin types, and writes it back for a form", () => {
    expect(parseCedis("12.5")).toBe(1250);
    expect(parseCedis("GH₵1,200")).toBe(120000);
    expect(parseCedis("15")).toBe(1500);
    expect(parseCedis("1.234")).toBeNull();
    expect(parseCedis("abc")).toBeNull();
    expect(cedisInput(1275)).toBe("12.75");
    expect(cedisInput(1500)).toBe("15");
  });
  it("percent shows — with nothing to divide by; counts are grouped", () => {
    expect(percent(0.874)).toBe("87%");
    expect(percent(null)).toBe("—");
    expect(count(12345)).toBe("12,345");
  });
});

describe("Accra time (GMT, whatever the computer's zone)", () => {
  const t = "2026-10-31T17:42:00.000Z";
  it("formats clock, day and both", () => {
    expect(clock(t)).toBe("5:42 pm");
    expect(clock("2026-10-31T00:05:00Z")).toBe("12:05 am");
    expect(shortDay(t)).toBe("Sat 31 Oct");
    expect(dayAndTime(t)).toBe("Sat 31 Oct, 5:42 pm");
    expect(hourLabel(18)).toBe("6 pm");
    expect(hourLabel(12)).toBe("12 pm");
    expect(hourLabel(0, false)).toBe("12");
  });
  it("durations and hours online", () => {
    expect(duration(45_000)).toBe("45 s");
    expect(duration(100_000)).toBe("1 min 40 s");
    expect(duration(12 * 60_000)).toBe("12 min");
    expect(duration(125 * 60_000)).toBe("2 h 5 min");
    expect(duration(null)).toBe("—");
    expect(hours(31 * 3_600_000)).toBe("31 h");
    expect(hours(45 * 60_000)).toBe("45 min");
    expect(hours(0)).toBe("—");
  });
  it("'ago' and weeks starting Monday", () => {
    const now = Date.parse(t);
    expect(ago(now - 12_000, now)).toBe("12 s ago");
    expect(ago(now - 3 * 60_000, now)).toBe("3 min ago");
    expect(ago(null, now)).toBe("never");
    expect(mondayOf(new Date(t)).toISOString()).toBe("2026-10-26T00:00:00.000Z");
    expect(mondayOf(new Date("2026-10-26T08:00:00Z")).toISOString()).toBe("2026-10-26T00:00:00.000Z");
    expect(mondayOf(new Date("2026-11-01T23:00:00Z")).toISOString()).toBe("2026-10-26T00:00:00.000Z");
  });
});

describe("periods", () => {
  const now = Date.parse("2026-10-31T17:42:00.000Z"); // a Saturday
  it("presets are whole Accra days, weeks from Monday", () => {
    const today = presetPeriod("today", now);
    expect([today.from.toISOString(), today.to.toISOString()]).toEqual(["2026-10-31T00:00:00.000Z", "2026-11-01T00:00:00.000Z"]);
    const week = presetPeriod("this-week", now);
    expect([week.from.toISOString(), week.to.toISOString()]).toEqual(["2026-10-26T00:00:00.000Z", "2026-11-02T00:00:00.000Z"]);
    expect(presetPeriod("last-week", now).from.toISOString()).toBe("2026-10-19T00:00:00.000Z");
    expect(presetPeriod("this-month", now).to.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(presetPeriod("yesterday", now).from.toISOString()).toBe("2026-10-30T00:00:00.000Z");
  });
  it("labels, comparisons and the API query", () => {
    expect(periodLabel(presetPeriod("this-week", now))).toBe("This week · Mon 26 Oct – Sun 1 Nov");
    expect(periodLabel(presetPeriod("today", now))).toBe("Today · Sat 31 Oct");
    expect(comparisonLabel(presetPeriod("today", now))).toBe("last Saturday");
    expect(periodQuery(presetPeriod("today", now))).toBe("from=2026-10-31T00%3A00%3A00.000Z&to=2026-11-01T00%3A00%3A00.000Z");
  });
  it("custom ranges include both days, and round-trip through the URL", () => {
    const p = customPeriod("2026-10-01", "2026-10-07")!;
    expect(p.to.toISOString()).toBe("2026-10-08T00:00:00.000Z");
    expect(customPeriod("2026-10-07", "2026-10-01")).toBeNull();
    expect(customPeriod("x", "y")).toBeNull();
    const back = periodFromSearch(new URLSearchParams(periodToSearch(p)))!;
    expect(back.from.getTime()).toBe(p.from.getTime());
    expect(back.to.getTime()).toBe(p.to.getTime());
    expect(periodFromSearch(new URLSearchParams("period=this-week"), now)!.preset).toBe("this-week");
    expect(periodFromSearch(new URLSearchParams("period=nonsense"), now)).toBeNull();
  });
});

describe("CSV", () => {
  it("quotes commas and quotes, and defuses formulas", () => {
    expect(csvCell("Balme Library, main gate")).toBe('"Balme Library, main gate"');
    expect(csvCell('He said "hi"')).toBe('"He said ""hi"""');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell(-3)).toBe("-3");
    expect(csvCell(null)).toBe("");
    expect(toCsv(["a", "b"], [[1, "x,y"]])).toBe('a,b\r\n1,"x,y"');
  });
});

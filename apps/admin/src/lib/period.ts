import { DAY_MS, midnightOf, mondayOf, shortDay } from "./time";

/**
 * The period picker's choices, as [from, to) in Accra time (= UTC). A page
 * remembers the last one chosen (localStorage, per page) and puts it in the
 * URL (?period=…, or ?from=YYYY-MM-DD&to=YYYY-MM-DD for a custom range) so a
 * link opens the same view.
 */

export type PeriodPreset = "today" | "yesterday" | "this-week" | "last-week" | "this-month" | "last-30" | "all-time" | "custom";

export interface Period {
  preset: PeriodPreset;
  from: Date;
  to: Date;
}

export const PRESET_LABELS: Record<PeriodPreset, string> = {
  today: "Today",
  yesterday: "Yesterday",
  "this-week": "This week",
  "last-week": "Last week",
  "this-month": "This month",
  "last-30": "Last 30 days",
  "all-time": "All time",
  custom: "Custom",
};

/** When records begin: the pilot's first rides (all time starts here). */
export const ALL_TIME_FROM = new Date("2026-01-01T00:00:00.000Z");

/** The period a preset means at `now`. */
export function presetPeriod(preset: Exclude<PeriodPreset, "custom">, now: number = Date.now()): Period {
  const today = midnightOf(now).getTime();
  switch (preset) {
    case "today":
      return { preset, from: new Date(today), to: new Date(today + DAY_MS) };
    case "yesterday":
      return { preset, from: new Date(today - DAY_MS), to: new Date(today) };
    case "this-week": {
      const monday = mondayOf(now).getTime();
      return { preset, from: new Date(monday), to: new Date(monday + 7 * DAY_MS) };
    }
    case "last-week": {
      const monday = mondayOf(now).getTime();
      return { preset, from: new Date(monday - 7 * DAY_MS), to: new Date(monday) };
    }
    case "this-month": {
      const t = new Date(now);
      return {
        preset,
        from: new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1)),
        to: new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 1)),
      };
    }
    case "last-30":
      return { preset, from: new Date(today - 29 * DAY_MS), to: new Date(today + DAY_MS) };
    case "all-time":
      return { preset, from: ALL_TIME_FROM, to: new Date(today + DAY_MS) };
  }
}

/** A custom range of whole days, both ends included ("2026-10-26" to "2026-11-01"); null if it isn't one. */
export function customPeriod(fromDay: string, toDay: string): Period | null {
  const from = Date.parse(`${fromDay}T00:00:00.000Z`);
  const to = Date.parse(`${toDay}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDay) || !/^\d{4}-\d{2}-\d{2}$/.test(toDay) || Number.isNaN(from) || Number.isNaN(to) || to < from) return null;
  if (to - from > 366 * DAY_MS) return null;
  return { preset: "custom", from: new Date(from), to: new Date(to + DAY_MS) };
}

/** "This week · Mon 26 Oct – Sun 1 Nov", "Today · Sat 31 Oct". */
export function periodLabel(p: Period): string {
  const last = new Date(p.to.getTime() - 1);
  const range = p.to.getTime() - p.from.getTime() <= DAY_MS ? shortDay(p.from) : `${shortDay(p.from)} – ${shortDay(last)}`;
  return p.preset === "custom" ? range : `${PRESET_LABELS[p.preset]} · ${range}`;
}

/** The query string the API takes. */
export function periodQuery(p: Period): string {
  return `from=${encodeURIComponent(p.from.toISOString())}&to=${encodeURIComponent(p.to.toISOString())}`;
}

/** What the page says the comparison is against ("last Saturday", "last week"). */
export function comparisonLabel(p: Period): string {
  if (p.preset === "today") return `last ${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][p.from.getUTCDay()]}`;
  if (p.preset === "this-week") return "last week";
  return "a week earlier";
}

/** Reads ?period= / ?from=&to= from a URL, else null. */
export function periodFromSearch(search: URLSearchParams, now: number = Date.now()): Period | null {
  const from = search.get("from");
  const to = search.get("to");
  if (from && to) return customPeriod(from, to);
  const preset = search.get("period") as PeriodPreset | null;
  if (preset && preset !== "custom" && preset in PRESET_LABELS) return presetPeriod(preset, now);
  return null;
}

/** The URL form of a period. */
export function periodToSearch(p: Period): Record<string, string> {
  if (p.preset === "custom") {
    return { from: p.from.toISOString().slice(0, 10), to: new Date(p.to.getTime() - DAY_MS).toISOString().slice(0, 10) };
  }
  return { period: p.preset };
}

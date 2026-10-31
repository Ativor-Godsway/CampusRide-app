/**
 * Periods and time buckets for the admin dashboard (docs/admin-metrics.md).
 *
 * Every day and hour is Accra time. Ghana is on GMT all year (no daylight
 * saving), so Accra time is UTC: a day runs 00:00–24:00 UTC and the hour of
 * a moment is its UTC hour. ACCRA_OFFSET_MINUTES says so in one place.
 * Weeks start on Monday.
 */

export const ACCRA_OFFSET_MINUTES = 0;
const DAY_MS = 24 * 60 * 60_000;
const WEEK_MS = 7 * DAY_MS;
/** The longest period one request may ask about. */
export const MAX_PERIOD_DAYS = 400;

export interface Period {
  from: Date;
  to: Date;
}

/** A moment shifted so its UTC fields read as Accra time. */
function accra(d: Date): Date {
  return new Date(d.getTime() + ACCRA_OFFSET_MINUTES * 60_000);
}

/** 0–23, Accra time. */
export function accraHour(d: Date): number {
  return accra(d).getUTCHours();
}

/** 0 = Monday … 6 = Sunday, Accra time. */
export function accraWeekday(d: Date): number {
  return (accra(d).getUTCDay() + 6) % 7;
}

/** "2026-10-31", Accra time. */
export function accraDay(d: Date): string {
  return accra(d).toISOString().slice(0, 10);
}

/** Midnight (Accra) starting the day `day` ("YYYY-MM-DD"), or null if it isn't a date. */
export function startOfAccraDay(day: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const t = Date.parse(`${day}T00:00:00.000Z`);
  if (Number.isNaN(t)) return null;
  return new Date(t - ACCRA_OFFSET_MINUTES * 60_000);
}

/**
 * `?from=&to=` (ISO instants) as a period, or an error in words. Both are
 * required; `to` must be after `from`, and the span at most MAX_PERIOD_DAYS.
 */
export function parsePeriod(query: { from?: unknown; to?: unknown }): Period | { error: string } {
  const from = typeof query.from === "string" ? new Date(query.from) : null;
  const to = typeof query.to === "string" ? new Date(query.to) : null;
  if (!from || Number.isNaN(from.getTime()) || !to || Number.isNaN(to.getTime())) {
    return { error: "from and to must be ISO times" };
  }
  if (to.getTime() <= from.getTime()) return { error: "to must be after from" };
  if (to.getTime() - from.getTime() > MAX_PERIOD_DAYS * DAY_MS) {
    return { error: `A period can be at most ${MAX_PERIOD_DAYS} days` };
  }
  return { from, to };
}

/** The same period one week earlier: the comparison "vs last week" uses. */
export function weekEarlier(p: Period): Period {
  return { from: new Date(p.from.getTime() - WEEK_MS), to: new Date(p.to.getTime() - WEEK_MS) };
}

/** Cache key part for a period. */
export function periodKey(p: Period): string {
  return `${p.from.toISOString()}~${p.to.toISOString()}`;
}

/** Every Accra day the period touches ("YYYY-MM-DD"), in order. */
export function daysIn(p: Period): string[] {
  const out: string[] = [];
  const first = startOfAccraDay(accraDay(p.from))!;
  for (let t = first.getTime(); t < p.to.getTime(); t += DAY_MS) out.push(accraDay(new Date(t)));
  return out;
}

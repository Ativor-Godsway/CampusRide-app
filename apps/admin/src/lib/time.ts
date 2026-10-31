/**
 * Dates and times on the admin site are Accra time. Ghana is on GMT all year
 * (no daylight saving), so Accra time is UTC: every formatter here reads the
 * UTC fields, whatever time zone the admin's own computer is in. Weeks start
 * on Monday.
 */

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const LONG_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const LONG_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

export const DAY_MS = 24 * 60 * 60_000;

function d(value: Date | string | number): Date {
  return value instanceof Date ? value : new Date(value);
}

/** "5:42 pm". */
export function clock(value: Date | string | number): string {
  const t = d(value);
  const h = t.getUTCHours();
  const m = String(t.getUTCMinutes()).padStart(2, "0");
  return `${h % 12 === 0 ? 12 : h % 12}:${m} ${h < 12 ? "am" : "pm"}`;
}

/** "6 pm", "7 am" for an hour of the day (0–23). */
export function hourLabel(hour: number, withHalf = true): string {
  const h = ((hour % 24) + 24) % 24;
  const n = h % 12 === 0 ? 12 : h % 12;
  return withHalf ? `${n} ${h < 12 ? "am" : "pm"}` : String(n);
}

/** "Sat 31 Oct". */
export function shortDay(value: Date | string | number): string {
  const t = d(value);
  return `${DAYS[t.getUTCDay()]} ${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]}`;
}

/** "Saturday 31 October". */
export function longDay(value: Date | string | number): string {
  const t = d(value);
  return `${LONG_DAYS[t.getUTCDay()]} ${t.getUTCDate()} ${LONG_MONTHS[t.getUTCMonth()]}`;
}

/** "Fri 30 Oct, 6:10 pm". */
export function dayAndTime(value: Date | string | number): string {
  return `${shortDay(value)}, ${clock(value)}`;
}

/** "5:42 pm" today, "Fri 30 Oct, 6:10 pm" another day. */
export function whenShort(value: Date | string | number, now: number = Date.now()): string {
  return sameDay(d(value), new Date(now)) ? clock(value) : dayAndTime(value);
}

export function sameDay(a: Date, b: Date): boolean {
  return a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
}

/** "YYYY-MM-DD" (Accra). */
export function isoDay(value: Date | string | number): string {
  return d(value).toISOString().slice(0, 10);
}

/** "45 s", "1 min 40 s", "12 min", "2 h 5 min"; "—" for nothing. */
export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 10) return s % 60 ? `${m} min ${String(s % 60).padStart(2, "0")} s` : `${m} min`;
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/** Hours online, whole: "31 h", "45 min" under an hour, "—" for none. */
export function hours(ms: number | null | undefined): string {
  if (!ms) return "—";
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.round(ms / (60 * 60_000))} h`;
}

/** "just now", "12 s ago", "4 min ago", "3 h ago", "2 days ago". */
export function ago(value: Date | string | number | null | undefined, now: number = Date.now()): string {
  if (value === null || value === undefined) return "never";
  const s = Math.max(0, Math.round((now - d(value).getTime()) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} days ago`;
}

/** Monday (Accra) of the week `value` is in, at midnight. */
export function mondayOf(value: Date | number): Date {
  const t = d(value);
  const midnight = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
  const weekday = (t.getUTCDay() + 6) % 7;
  return new Date(midnight - weekday * DAY_MS);
}

/** Midnight (Accra) of the day `value` is in. */
export function midnightOf(value: Date | number): Date {
  const t = d(value);
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
}

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

/** "17:42" (24-hour, Ghana time). */
export function clock(value: Date | string | number): string {
  const t = d(value);
  return `${String(t.getUTCHours()).padStart(2, "0")}:${String(t.getUTCMinutes()).padStart(2, "0")}`;
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

/**
 * A moment the human way, Ghana time: "Today 09:14", "Yesterday 18:02",
 * "Fri 30 Oct 18:10" (with the year when it isn't this year's).
 */
export function dayAndTime(value: Date | string | number, now: number = Date.now()): string {
  const t = d(value);
  const today = midnightOf(now).getTime();
  const day = midnightOf(t).getTime();
  if (day === today) return `Today ${clock(t)}`;
  if (day === today - DAY_MS) return `Yesterday ${clock(t)}`;
  if (day === today + DAY_MS) return `Tomorrow ${clock(t)}`;
  const year = t.getUTCFullYear() !== new Date(now).getUTCFullYear() ? ` ${t.getUTCFullYear()}` : "";
  return `${shortDay(t)}${year} ${clock(t)}`;
}

/** "17:42" today, else as dayAndTime. */
export function whenShort(value: Date | string | number, now: number = Date.now()): string {
  return sameDay(d(value), new Date(now)) ? clock(value) : dayAndTime(value, now);
}

/** "Today", "Yesterday", "Mon 23 Nov" for a day ("YYYY-MM-DD" or a moment). */
export function humanDay(value: Date | string | number, now: number = Date.now()): string {
  const t = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : d(value);
  const today = midnightOf(now).getTime();
  const day = midnightOf(t).getTime();
  if (day === today) return "Today";
  if (day === today - DAY_MS) return "Yesterday";
  return shortDay(t);
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

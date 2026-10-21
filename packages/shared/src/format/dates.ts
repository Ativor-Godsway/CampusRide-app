/**
 * Times and days in the words the apps show: "6:47 PM", and the day headings
 * of a trip history ("Today", "Yesterday", "Mon 19 Oct"). Written out by
 * hand rather than with Intl, so every phone shows the same thing. Phone's
 * own time zone throughout.
 */

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** "6:47 PM". */
export function clockTime(value: Date | string | number): string {
  const at = new Date(value);
  const h = at.getHours();
  return `${h % 12 === 0 ? 12 : h % 12}:${String(at.getMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** Midnight at the start of `value`'s day. */
function startOfDay(value: Date | string | number): number {
  const d = new Date(value);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** "Today", "Yesterday", "Mon 19 Oct" (with the year when it isn't this year: "Fri 19 Dec 2025"). */
export function dayLabel(value: Date | string | number, now: Date = new Date()): string {
  const day = startOfDay(value);
  const today = startOfDay(now);
  if (day === today) return "Today";
  // Subtract a day by date, not by 24 h, so a clock change can't skip one.
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (day === yesterday.getTime()) return "Yesterday";
  const d = new Date(day);
  const label = `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === now.getFullYear() ? label : `${label} ${d.getFullYear()}`;
}

/** Items (already newest first) in runs that share a day heading, in the same order. */
export function groupByDay<T>(
  items: readonly T[],
  dateOf: (item: T) => Date | string | number,
  now: Date = new Date(),
): { label: string; items: T[] }[] {
  const groups: { label: string; items: T[] }[] = [];
  for (const item of items) {
    const label = dayLabel(dateOf(item), now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

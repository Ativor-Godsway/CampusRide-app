/**
 * The admin dashboard's arithmetic, as plain functions (no database), so
 * every definition in docs/admin-metrics.md is tested on its own:
 * medians, hours online clipped to a period, acceptance rate, and the
 * Supply & demand verdict rule.
 */
import { accraHour, accraWeekday, type Period } from "./period";

const HOUR_MS = 60 * 60_000;

/** The median, or null for no values. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** part ÷ whole, or null when whole is 0 (the page shows "—", not 0%). */
export function ratio(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

export interface OnlineSession {
  driverUserId: string;
  startedAt: Date;
  /** Null while still online: it counts up to `now`. */
  endedAt: Date | null;
}

/** [start, end) of a session inside the period, in epoch ms; null when none of it is. */
function clip(s: OnlineSession, period: Period, now: Date): [number, number] | null {
  const start = Math.max(s.startedAt.getTime(), period.from.getTime());
  const end = Math.min(s.endedAt ? s.endedAt.getTime() : now.getTime(), period.to.getTime());
  return end > start ? [start, end] : null;
}

/** Milliseconds of a session inside the period (a session spanning midnight is split by the period, not by the day). */
export function clippedMs(s: OnlineSession, period: Period, now: Date): number {
  const c = clip(s, period, now);
  return c ? c[1] - c[0] : 0;
}

/** Each [start, end) split at Accra hour boundaries: calls `each(hourStartMs, ms)`. */
function eachHourSlice(start: number, end: number, each: (hourStart: number, ms: number) => void): void {
  let t = start;
  while (t < end) {
    const hourStart = Math.floor(t / HOUR_MS) * HOUR_MS;
    const next = Math.min(end, hourStart + HOUR_MS);
    each(hourStart, next - t);
    t = next;
  }
}

/** Driver-milliseconds online in each hour of the day (0–23, Accra), summed over the period. */
export function onlineMsByHourOfDay(sessions: readonly OnlineSession[], period: Period, now: Date): number[] {
  const out = new Array<number>(24).fill(0);
  for (const s of sessions) {
    const c = clip(s, period, now);
    if (!c) continue;
    eachHourSlice(c[0], c[1], (hourStart, ms) => {
      out[accraHour(new Date(hourStart))]! += ms;
    });
  }
  return out;
}

/** How many different drivers were online at some point in each hour (0–23) of the period (meant for one day). */
export function driversOnlineByHour(sessions: readonly OnlineSession[], period: Period, now: Date): number[] {
  const seen = Array.from({ length: 24 }, () => new Set<string>());
  for (const s of sessions) {
    const c = clip(s, period, now);
    if (!c) continue;
    eachHourSlice(c[0], c[1], (hourStart) => {
      seen[accraHour(new Date(hourStart))]!.add(s.driverUserId);
    });
  }
  return seen.map((set) => set.size);
}

export type OfferOutcome = "ACCEPTED" | "DECLINED" | "TIMED_OUT" | "TAKEN" | "CANCELLED" | "EXPIRED";

export interface OfferRecord {
  outcome: OfferOutcome | null;
  offeredAt: Date;
  decidedAt: Date | null;
}

/**
 * Acceptance rate = accepted ÷ (accepted + declined + timed out). Taken by
 * another driver, cancelled by the rider and expired don't count against the
 * driver; nor does an offer still open. Average reply = mean time to an
 * answer the driver gave (accepted or declined); a time-out is not a reply.
 */
export function acceptance(offers: readonly OfferRecord[]): {
  offers: number;
  accepted: number;
  declined: number;
  timedOut: number;
  rate: number | null;
  avgReplyMs: number | null;
} {
  let accepted = 0;
  let declined = 0;
  let timedOut = 0;
  const replies: number[] = [];
  for (const o of offers) {
    if (o.outcome === "ACCEPTED") accepted += 1;
    else if (o.outcome === "DECLINED") declined += 1;
    else if (o.outcome === "TIMED_OUT") timedOut += 1;
    if ((o.outcome === "ACCEPTED" || o.outcome === "DECLINED") && o.decidedAt) {
      replies.push(o.decidedAt.getTime() - o.offeredAt.getTime());
    }
  }
  const avg = replies.length ? replies.reduce((a, b) => a + b, 0) / replies.length : null;
  return { offers: offers.length, accepted, declined, timedOut, rate: ratio(accepted, accepted + declined + timedOut), avgReplyMs: avg };
}

// ─── Supply & demand verdict ────────────────────────────────────────────────

/** The eight 3-hour windows of a day, starting at 7 am (Accra). */
export const VERDICT_WINDOW_STARTS = [7, 10, 13, 16, 19, 22, 1, 4] as const;
/** A window needs at least this many requests, and this share without a driver, to call for more drivers. */
export const VERDICT_MIN_REQUESTS = 3;
export const VERDICT_MIN_NO_DRIVER_RATE = 0.15;
/** "Need N more drivers" never asks for more than this. */
export const VERDICT_MAX_DRIVERS = 5;

/** Which window (index into VERDICT_WINDOW_STARTS) an Accra hour falls in. */
export function verdictWindowOf(hour: number): number {
  return Math.floor((((hour - 7) % 24) + 24) % 24 / 3);
}

/** "7 am", "12 pm". */
function hourWord(h: number): { n: number; half: "am" | "pm" } {
  const hour = ((h % 24) + 24) % 24;
  return { n: hour % 12 === 0 ? 12 : hour % 12, half: hour < 12 ? "am" : "pm" };
}

/** "4–7 pm", "10 am–1 pm", "10 pm–1 am". */
export function hourRangeLabel(start: number, end: number): string {
  const a = hourWord(start);
  const b = hourWord(end);
  return a.half === b.half ? `${a.n}–${b.n} ${b.half}` : `${a.n} ${a.half}–${b.n} ${b.half}`;
}

export function verdictWindowLabel(index: number): string {
  const start = VERDICT_WINDOW_STARTS[index]!;
  return hourRangeLabel(start, start + 3);
}

export interface VerdictRequest {
  zoneId: string;
  createdAt: Date;
  noDriver: boolean;
}

export interface VerdictInput {
  requests: readonly VerdictRequest[];
  /** When each completed trip of the period was requested (all zones). */
  completedTripTimes: readonly Date[];
  /** Driver-milliseconds online per hour of day over the period (onlineMsByHourOfDay). */
  onlineMsByHour: readonly number[];
}

export interface WindowNeed {
  window: number;
  label: string;
  requests: number;
  noDriver: number;
  /** Completed trips per online driver-hour in this window, over the whole campus. */
  tripsPerDriverHour: number;
  need: number;
}

export interface ZoneVerdict {
  zoneId: string;
  /** 0 = OK. */
  need: number;
  /** The window that needs the most, when one does. */
  worst: WindowNeed | null;
  /** Every window that needs drivers, worst first. */
  windows: WindowNeed[];
}

/** Completed trips per online driver-hour in each window. */
function windowProductivity(input: VerdictInput): number[] {
  const trips = new Array<number>(8).fill(0);
  for (const t of input.completedTripTimes) trips[verdictWindowOf(accraHour(t))]! += 1;
  const hours = new Array<number>(8).fill(0);
  input.onlineMsByHour.forEach((ms, hour) => {
    hours[verdictWindowOf(hour)]! += ms / HOUR_MS;
  });
  return trips.map((n, w) => (hours[w]! > 0 ? n / hours[w]! : 0));
}

/** N = ceil(no-driver ÷ max(1, trips per driver-hour)), capped at VERDICT_MAX_DRIVERS. */
export function driversNeeded(noDriver: number, tripsPerDriverHour: number): number {
  return Math.min(VERDICT_MAX_DRIVERS, Math.ceil(noDriver / Math.max(1, tripsPerDriverHour)));
}

function qualifies(requests: number, noDriver: number): boolean {
  return requests >= VERDICT_MIN_REQUESTS && noDriver / requests >= VERDICT_MIN_NO_DRIVER_RATE;
}

function byWorst(a: WindowNeed, b: WindowNeed): number {
  return b.need - a.need || b.noDriver - a.noDriver || a.window - b.window;
}

/**
 * The verdict rule (docs/admin-metrics.md): for each pickup zone and 3-hour
 * window of the period, if at least 15% of at least 3 requests found no
 * driver, the zone needs N more drivers in that window; otherwise OK.
 */
export function zoneVerdicts(input: VerdictInput): Map<string, ZoneVerdict> {
  const productivity = windowProductivity(input);
  const counts = new Map<string, Array<{ requests: number; noDriver: number }>>();
  for (const r of input.requests) {
    let zone = counts.get(r.zoneId);
    if (!zone) {
      zone = Array.from({ length: 8 }, () => ({ requests: 0, noDriver: 0 }));
      counts.set(r.zoneId, zone);
    }
    const cell = zone[verdictWindowOf(accraHour(r.createdAt))]!;
    cell.requests += 1;
    if (r.noDriver) cell.noDriver += 1;
  }
  const out = new Map<string, ZoneVerdict>();
  for (const [zoneId, windows] of counts) {
    const needs: WindowNeed[] = [];
    windows.forEach((cell, w) => {
      if (!qualifies(cell.requests, cell.noDriver)) return;
      needs.push({
        window: w,
        label: verdictWindowLabel(w),
        requests: cell.requests,
        noDriver: cell.noDriver,
        tripsPerDriverHour: productivity[w]!,
        need: driversNeeded(cell.noDriver, productivity[w]!),
      });
    });
    needs.sort(byWorst);
    out.set(zoneId, { zoneId, need: needs[0]?.need ?? 0, worst: needs[0] ?? null, windows: needs });
  }
  return out;
}

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** "Fri", "Fri and Sat", "Mon, Wed and Fri". */
function listDays(days: readonly number[]): string {
  const names = days.map((d) => DAY_NAMES[d]!);
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * One plain-English line for the top of Supply & demand. The rule applied
 * to the whole campus: of the windows where some zone needs drivers, the one
 * needing most (all its no-driver requests, every zone) — "Ask 2 more
 * drivers to be online Fri and Sat, 4–7 pm." The days are the weekdays with
 * at least a fifth of that window's no-driver requests (at most three, in
 * week order). Null when nothing needs drivers.
 */
export function supplySuggestion(input: VerdictInput, verdicts: Map<string, ZoneVerdict>): string | null {
  const flagged = new Set<number>();
  for (const v of verdicts.values()) for (const w of v.windows) flagged.add(w.window);
  if (flagged.size === 0) return null;

  const productivity = windowProductivity(input);
  const byWindow = new Map<number, VerdictRequest[]>();
  for (const r of input.requests) {
    if (!r.noDriver) continue;
    const w = verdictWindowOf(accraHour(r.createdAt));
    if (!flagged.has(w)) continue;
    byWindow.set(w, [...(byWindow.get(w) ?? []), r]);
  }
  let best: { window: number; need: number; misses: VerdictRequest[] } | null = null;
  for (const [window, misses] of byWindow) {
    const need = driversNeeded(misses.length, productivity[window]!);
    if (!best || need > best.need || (need === best.need && misses.length > best.misses.length)) {
      best = { window, need, misses };
    }
  }
  if (!best) return null;

  const perDay = new Array<number>(7).fill(0);
  for (const r of best.misses) perDay[accraWeekday(r.createdAt)]! += 1;
  const threshold = Math.max(1, best.misses.length / 5);
  const days = perDay
    .map((n, day) => ({ n, day }))
    .filter((d) => d.n >= threshold)
    .sort((a, b) => b.n - a.n || a.day - b.day)
    .slice(0, 3)
    .map((d) => d.day)
    .sort((a, b) => a - b);
  const who = best.need === 1 ? "1 more driver" : `${best.need} more drivers`;
  const when = days.length === 7 ? "every day" : listDays(days);
  return `Ask ${who} to be online ${when}, ${verdictWindowLabel(best.window)}.`;
}

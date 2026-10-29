/**
 * Launch mode: the countdown before CampusRide's public launch. The apps are
 * in the stores before launch day; until then riders can sign in and look
 * around, but only exempt riders (review demo accounts, admins, early
 * access) can book. Set in the admin site's Settings, stored on the server.
 *
 * - OFF: normal, everyone can ride (before launch mode is ever used).
 * - COUNTDOWN: until `launchAt`; at that moment it is LIVE by itself, with
 *   nobody pressing anything (effectiveLaunchMode).
 * - LIVE: launched, everyone can ride.
 *
 * All times are Ghana time, which is GMT all year (no daylight saving), so
 * "Ghana time" and UTC are the same clock and the words below are written
 * from the UTC fields, on every phone alike.
 *
 * A phone's own clock can be wrong by hours. Every status carries the
 * server's time, and the countdown runs on the server's clock as measured
 * when the answer arrived (clockOffsetMs), never on the phone's.
 */

export const LAUNCH_MODES = ["OFF", "COUNTDOWN", "LIVE"] as const;
export type LaunchMode = (typeof LAUNCH_MODES)[number];

/** Public: the same answer for everyone. */
export const LAUNCH_STATUS_PATH = "/launch-status";
/** Signed in: the same, plus whether this account can book now. */
export const MY_LAUNCH_STATUS_PATH = "/me/launch-status";

/** The `code` of POST /rides refused during the countdown (422, with `error` in words). */
export const LAUNCH_NOT_OPEN_CODE = "LAUNCH_NOT_OPEN";

/** What GET /launch-status answers. */
export interface LaunchStatus {
  /** The mode in force now: a countdown whose launchAt has passed is "LIVE". */
  mode: LaunchMode;
  /** ISO time of the public launch; set only while mode is COUNTDOWN. */
  launchAt: string | null;
  /** The server's clock when it answered (ISO), so a wrong phone clock can't move the countdown. */
  serverTime: string;
}

/** What GET /me/launch-status answers. */
export interface MyLaunchStatus extends LaunchStatus {
  /** Whether this account may book a ride right now (always true outside a countdown). */
  canRide: boolean;
}

/** Who rides during the countdown. */
export interface LaunchExemption {
  role: string;
  isReviewDemo: boolean;
  earlyAccessAt: Date | string | null;
}

/**
 * Exempt from the countdown: App Store / Google Play review demo accounts
 * (a "coming soon only" app is rejected), admins, and riders given early
 * access in the admin site (the pilot testers).
 */
export function isLaunchExempt(user: LaunchExemption): boolean {
  return user.isReviewDemo || user.role === "ADMIN" || user.earlyAccessAt !== null;
}

/** The mode in force at `now`: a countdown ends at its launch time by itself. */
export function effectiveLaunchMode(
  stored: { mode: LaunchMode; launchAt: Date | null },
  now: Date,
): LaunchMode {
  if (stored.mode !== "COUNTDOWN") return stored.mode;
  if (!stored.launchAt || stored.launchAt.getTime() <= now.getTime()) return "LIVE";
  return "COUNTDOWN";
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** "9:00 AM", Ghana time. */
export function launchClockTime(at: Date): string {
  const h = at.getUTCHours();
  return `${h % 12 === 0 ? 12 : h % 12}:${String(at.getUTCMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** "Saturday 14 November", Ghana time. */
export function launchDay(at: Date): string {
  return `${WEEKDAYS[at.getUTCDay()]} ${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}`;
}

/** "CampusRide opens on Saturday 14 November at 9:00 AM." — the refusal every app version shows. */
export function launchNotOpenMessage(launchAt: Date): string {
  return `CampusRide opens on ${launchDay(launchAt)} at ${launchClockTime(launchAt)}. See you then!`;
}

export interface CountdownParts {
  days: number;
  hours: number;
  minutes: number;
}

const MINUTE_MS = 60_000;

/**
 * Time left as days / hours / minutes, minutes rounded UP: with 30 seconds
 * to go it says 1 minute, and 0 only once it's time.
 */
export function countdownParts(remainingMs: number): CountdownParts {
  const totalMinutes = Math.max(0, Math.ceil(remainingMs / MINUTE_MS));
  return {
    days: Math.floor(totalMinutes / (24 * 60)),
    hours: Math.floor(totalMinutes / 60) % 24,
    minutes: totalMinutes % 60,
  };
}

/** "Opens in 2d 4h", "Opens in 3h 12m", "Opens in 5 min" — fits a button. */
export function opensInText({ days, hours, minutes }: CountdownParts): string {
  if (days > 0) return `Opens in ${days}d ${hours}h`;
  if (hours > 0) return `Opens in ${hours}h ${minutes}m`;
  return `Opens in ${Math.max(1, minutes)} min`;
}

/** "2 days, 4 hours and 12 minutes" — for screen readers and sentences. */
export function countdownWords({ days, hours, minutes }: CountdownParts): string {
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const parts: string[] = [];
  if (days > 0) parts.push(unit(days, "day"));
  if (days > 0 || hours > 0) parts.push(unit(hours, "hour"));
  parts.push(unit(parts.length > 0 ? minutes : Math.max(1, minutes), "minute"));
  const last = parts.pop()!;
  return parts.length > 0 ? `${parts.join(", ")} and ${last}` : last;
}

/**
 * A launch status as an app holds it: times as milliseconds, and how far the
 * phone's clock is from the server's (server minus phone, measured when the
 * answer arrived).
 */
export interface HeldLaunchStatus {
  mode: LaunchMode;
  launchAtMs: number | null;
  clockOffsetMs: number;
  /** From GET /me/launch-status; absent from the public one. */
  canRide?: boolean;
}

function isoMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Reads a GET /launch-status (or /me/launch-status) body that arrived at
 * `receivedAtMs` by the phone's clock. Anything unreadable is null, and the
 * app then shows no countdown (the server still decides who can book).
 */
export function readLaunchStatus(data: unknown, receivedAtMs: number): HeldLaunchStatus | null {
  if (!data || typeof data !== "object") return null;
  const body = data as Record<string, unknown>;
  const mode = body.mode;
  if (typeof mode !== "string" || !(LAUNCH_MODES as readonly string[]).includes(mode)) return null;
  const serverMs = isoMs(body.serverTime);
  const launchAtMs = isoMs(body.launchAt);
  if (mode === "COUNTDOWN" && launchAtMs === null) return null;
  return {
    mode: mode as LaunchMode,
    launchAtMs,
    clockOffsetMs: serverMs === null ? 0 : serverMs - receivedAtMs,
    ...(typeof body.canRide === "boolean" ? { canRide: body.canRide } : {}),
  };
}

export type LaunchView =
  | { kind: "open" }
  | { kind: "countdown"; launchAt: Date; remainingMs: number; parts: CountdownParts };

/**
 * What to show at `deviceNowMs` (the phone's clock, corrected by the held
 * offset): a countdown, or nothing ("open"). Open when there's no status,
 * outside a countdown, for someone who can ride (early access), and from the
 * launch moment on — so the card goes away by itself at launch time.
 */
export function launchViewAt(status: HeldLaunchStatus | null, deviceNowMs: number): LaunchView {
  if (!status || status.mode !== "COUNTDOWN" || status.launchAtMs === null) return { kind: "open" };
  if (status.canRide === true) return { kind: "open" };
  const remainingMs = status.launchAtMs - (deviceNowMs + status.clockOffsetMs);
  if (remainingMs <= 0) return { kind: "open" };
  return {
    kind: "countdown",
    launchAt: new Date(status.launchAtMs),
    remainingMs,
    parts: countdownParts(remainingMs),
  };
}

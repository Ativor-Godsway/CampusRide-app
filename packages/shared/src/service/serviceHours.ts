import { launchClockTime } from "../launch/launchMode";

/**
 * Service hours: when riders can book. Shared by the server (which decides,
 * isServiceOpen in services/service/serviceHours.ts), the admin site (which
 * edits the schedule and shows the state in force) and the apps (which show
 * the banner and disable Request), so the three never disagree.
 *
 * Time zone: Africa/Accra. Ghana is on GMT all year (UTC+0, no daylight
 * saving), so Accra wall-clock time IS the UTC clock: every day starts at
 * 00:00 UTC and "08:00" is 08:00 UTC, on every server and phone alike, with
 * no time-zone database needed (Hermes's Intl can't be relied on for zones).
 * ACCRA_UTC_OFFSET_MINUTES says so in one place; serviceHours.test.ts checks
 * it against the real Africa/Accra zone.
 *
 * Rules:
 * - A weekly schedule: per day of the week an opening and closing time, or
 *   closed all day. A closing time at or before the opening time runs past
 *   midnight into the next day ("20:00"–"02:00"); "24:00" closes at midnight.
 *   Back-to-back days join up (Mon 00:00–24:00 + Tue 00:00–12:00 is one
 *   stretch that closes Tuesday noon).
 * - A manual override: "Close now" lasts until the next scheduled opening,
 *   "Open now" until the next scheduled closing; then the schedule takes over
 *   by itself (nothing rewrites the stored row — every read compares the
 *   override's end with the clock).
 * - "Block requests when no drivers are online": during open hours, with no
 *   driver online, requests are refused too (reason NO_DRIVERS).
 *
 * Only NEW requests are refused. Requests already searching and trips going
 * on are never touched at closing time.
 */

export const SERVICE_TIME_ZONE = "Africa/Accra";
/** Accra is UTC+0 all year: wall-clock time there is UTC. */
export const ACCRA_UTC_OFFSET_MINUTES = 0;

/** Signed in: the status, plus whether this account books whatever the hours, and "notify me". */
export const MY_SERVICE_STATUS_PATH = "/me/service-status";
/** POST: tell me when CampusRide opens; DELETE: never mind. */
export const SERVICE_NOTIFY_PATH = "/me/service-notify";
/** Socket event to every connected app when the state in force changes (payload: ServiceStatus). */
export const SERVICE_STATUS_EVENT = "service:status";

/** POST /rides refused outside service hours (manual "Close now" included). */
export const SERVICE_CLOSED_CODE = "SERVICE_CLOSED";
/** POST /rides refused in open hours because no driver is online. */
export const NO_DRIVERS_ONLINE_CODE = "NO_DRIVERS_ONLINE";

export const SERVICE_REASONS = ["SCHEDULE", "MANUAL", "NO_DRIVERS"] as const;
export type ServiceReason = (typeof SERVICE_REASONS)[number];

export const SERVICE_OVERRIDE_MODES = ["OPEN", "CLOSED"] as const;
export type ServiceOverrideMode = (typeof SERVICE_OVERRIDE_MODES)[number];

/** One day's hours, "HH:MM" in Accra time. `close` may be "24:00", or at/before `open` (past midnight). */
export interface DayHours {
  open: string;
  close: string;
}

/** Index 0 = Sunday … 6 = Saturday (Date#getUTCDay). null = closed all day. */
export type WeeklySchedule = (DayHours | null)[];

/** Monday first, the way the admin site lists them. */
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export const DEFAULT_OPEN = "08:00";
export const DEFAULT_CLOSE = "17:00";
/** Every day 08:00–17:00 (also what applies before an admin ever saves). */
export const DEFAULT_WEEKLY_SCHEDULE: WeeklySchedule = Array.from({ length: 7 }, () => ({
  open: DEFAULT_OPEN,
  close: DEFAULT_CLOSE,
}));

/** The longest custom closed message ("Closed for the holiday"). */
export const SERVICE_MESSAGE_MAX = 120;

export interface ServiceOverride {
  mode: ServiceOverrideMode;
  /** When the schedule takes over again; null = no scheduled change ahead (lasts until changed). */
  until: Date | null;
}

export interface ServiceSettings {
  weekly: WeeklySchedule;
  override: ServiceOverride | null;
  /** Shown to riders whenever CampusRide is closed (not for "no drivers"). */
  closedMessage: string | null;
  blockWhenNoDrivers: boolean;
}

export const DEFAULT_SERVICE_SETTINGS: ServiceSettings = {
  weekly: DEFAULT_WEEKLY_SCHEDULE,
  override: null,
  closedMessage: null,
  blockWhenNoDrivers: true,
};

/** isServiceOpen's answer, as the server computes it (Dates). */
export interface ServiceState {
  open: boolean;
  /** Why it is open or closed now: the schedule, a manual override, or no drivers online. */
  reason: ServiceReason;
  /** Closed by SCHEDULE/MANUAL: when it opens again (null: no opening ahead). Null when open or NO_DRIVERS. */
  nextOpenAt: Date | null;
  /** Open hours (also during NO_DRIVERS): when they end (null: no closing ahead). Null when closed. */
  closesAt: Date | null;
  /** The custom closed message, when closed by SCHEDULE/MANUAL and one is set. */
  message: string | null;
  /** Today's scheduled hours (Accra), for the driver app's "Service hours 8:00 AM – 5:00 PM". */
  today: DayHours | null;
}

/** The wire form (GET /app/config `service`, GET /me/service-status, the socket event). */
export interface ServiceStatus {
  open: boolean;
  reason: ServiceReason;
  nextOpenAt: string | null;
  closesAt: string | null;
  message: string | null;
  today: DayHours | null;
  /** The server's clock when it answered, so a wrong phone clock can't move "closes at". */
  serverTime: string;
}

/** GET /me/service-status. */
export interface MyServiceStatus extends ServiceStatus {
  /** This account books whatever the hours say (store review demo accounts, admins). */
  exempt: boolean;
  /** This rider asked to be told when CampusRide opens. */
  notifyMe: boolean;
}

// ─── Clock times ────────────────────────────────────────────────────────────

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** "08:30" → 510; "24:00" (closing only) → 1440; anything else → null. */
export function clockMinutes(value: unknown, { closing = false } = {}): number | null {
  if (typeof value !== "string") return null;
  if (closing && value === "24:00") return 24 * 60;
  const m = CLOCK.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** "17:00" → "5:00 PM"; "24:00" → "midnight". */
export function clockWords(value: string): string {
  if (value === "24:00") return "midnight";
  const minutes = clockMinutes(value);
  if (minutes === null) return value;
  return launchClockTime(new Date(minutes * MINUTE_MS));
}

/** "8:00 AM – 5:00 PM", or "Closed all day". */
export function dayHoursWords(hours: DayHours | null): string {
  return hours ? `${clockWords(hours.open)} – ${clockWords(hours.close)}` : "Closed all day";
}

/** Start of the Accra day `at` falls in. */
export function accraDayStart(at: Date): number {
  const offset = ACCRA_UTC_OFFSET_MINUTES * MINUTE_MS;
  return Math.floor((at.getTime() + offset) / DAY_MS) * DAY_MS - offset;
}

/** 0 = Sunday … 6 = Saturday, in Accra. */
export function accraWeekday(at: Date): number {
  return new Date(at.getTime() + ACCRA_UTC_OFFSET_MINUTES * MINUTE_MS).getUTCDay();
}

// ─── The schedule ───────────────────────────────────────────────────────────

/**
 * A schedule as stored or sent by the admin site, checked: exactly 7 days,
 * each null or a valid open/close (not equal). Returns the problem in words.
 */
export function readWeeklySchedule(value: unknown): { weekly: WeeklySchedule } | { error: string } {
  if (!Array.isArray(value) || value.length !== 7) return { error: "The schedule needs all 7 days." };
  const weekly: WeeklySchedule = [];
  for (let day = 0; day < 7; day++) {
    const entry: unknown = value[day];
    if (entry === null) {
      weekly.push(null);
      continue;
    }
    const { open, close } = (entry ?? {}) as { open?: unknown; close?: unknown };
    const o = clockMinutes(open);
    const c = clockMinutes(close, { closing: true });
    const name = WEEKDAY_NAMES[day];
    if (o === null || c === null) return { error: `${name}: opening and closing times must be like 08:00.` };
    if (o === c) {
      return { error: `${name}: opening and closing can't be the same time. For all day, use 00:00 to 24:00.` };
    }
    weekly.push({ open: open as string, close: close as string });
  }
  return { weekly };
}

interface Stretch {
  start: number;
  end: number;
}

/** How far ahead (days) the next opening or closing is looked for. A week plus a day covers any schedule. */
const LOOKAHEAD_DAYS = 8;

/**
 * The open stretches from the day before `at` to LOOKAHEAD_DAYS after,
 * joined where one ends as (or after) the next starts. A stretch running to
 * the end of the window is open-ended (`end` = Infinity): no closing ahead.
 */
function openStretches(weekly: WeeklySchedule, at: Date): Stretch[] {
  const today = accraDayStart(at);
  const windowEnd = today + (LOOKAHEAD_DAYS + 1) * DAY_MS;
  const raw: Stretch[] = [];
  for (let d = -1; d <= LOOKAHEAD_DAYS; d++) {
    const dayStart = today + d * DAY_MS;
    const hours = weekly[accraWeekday(new Date(dayStart))];
    if (!hours) continue;
    const o = clockMinutes(hours.open);
    const c = clockMinutes(hours.close, { closing: true });
    if (o === null || c === null || o === c) continue;
    const start = dayStart + o * MINUTE_MS;
    const end = c > o ? dayStart + c * MINUTE_MS : dayStart + DAY_MS + c * MINUTE_MS;
    raw.push({ start, end });
  }
  raw.sort((a, b) => a.start - b.start);
  const joined: Stretch[] = [];
  for (const s of raw) {
    const last = joined[joined.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else joined.push({ ...s });
  }
  for (const s of joined) if (s.end >= windowEnd) s.end = Infinity;
  return joined;
}

/** What the schedule alone says at `at`. Open at the opening minute exactly, closed at the closing minute. */
export function scheduleAt(
  weekly: WeeklySchedule,
  at: Date,
): { open: boolean; closesAt: Date | null; nextOpenAt: Date | null } {
  const t = at.getTime();
  const stretches = openStretches(weekly, at);
  const current = stretches.find((s) => s.start <= t && t < s.end);
  if (current) {
    return { open: true, closesAt: Number.isFinite(current.end) ? new Date(current.end) : null, nextOpenAt: null };
  }
  const next = stretches.find((s) => s.start > t);
  return { open: false, closesAt: null, nextOpenAt: next ? new Date(next.start) : null };
}

/**
 * When an override set at `at` ends: "Close now" at the next scheduled
 * opening after `at`, "Open now" at the next scheduled closing. Null when the
 * schedule has none ahead (the override lasts until someone changes it).
 */
export function overrideEnd(weekly: WeeklySchedule, mode: ServiceOverrideMode, at: Date): Date | null {
  const t = at.getTime();
  const stretches = openStretches(weekly, at);
  if (mode === "CLOSED") {
    const next = stretches.find((s) => s.start > t);
    return next ? new Date(next.start) : null;
  }
  const until = stretches.find((s) => s.end > t);
  return until && Number.isFinite(until.end) ? new Date(until.end) : null;
}

/** Whether an override is still in force at `at` (it ends at `until` exactly). */
export function overrideInForce(override: ServiceOverride | null, at: Date): override is ServiceOverride {
  return override !== null && (override.until === null || at.getTime() < override.until.getTime());
}

/**
 * The one rule (isServiceOpen on the server is this with the stored
 * settings and the live count of online drivers).
 */
export function serviceStateAt(settings: ServiceSettings, at: Date, driversOnline: number): ServiceState {
  const today = settings.weekly[accraWeekday(at)] ?? null;
  const schedule = scheduleAt(settings.weekly, at);
  const override = overrideInForce(settings.override, at) ? settings.override : null;

  let hoursOpen: boolean;
  let reason: ServiceReason;
  let closesAt: Date | null;
  let nextOpenAt: Date | null;
  if (override) {
    hoursOpen = override.mode === "OPEN";
    reason = "MANUAL";
    closesAt = hoursOpen ? override.until : null;
    nextOpenAt = hoursOpen ? null : override.until;
  } else {
    hoursOpen = schedule.open;
    reason = "SCHEDULE";
    closesAt = schedule.closesAt;
    nextOpenAt = schedule.nextOpenAt;
  }

  if (!hoursOpen) {
    return { open: false, reason, nextOpenAt, closesAt: null, message: settings.closedMessage, today };
  }
  if (settings.blockWhenNoDrivers && driversOnline <= 0) {
    return { open: false, reason: "NO_DRIVERS", nextOpenAt: null, closesAt, message: null, today };
  }
  return { open: true, reason, nextOpenAt: null, closesAt, message: null, today };
}

export function serviceStatusFromState(state: ServiceState, now: Date): ServiceStatus {
  return {
    open: state.open,
    reason: state.reason,
    nextOpenAt: state.nextOpenAt?.toISOString() ?? null,
    closesAt: state.closesAt?.toISOString() ?? null,
    message: state.message,
    today: state.today,
    serverTime: now.toISOString(),
  };
}

// ─── Words ──────────────────────────────────────────────────────────────────

const LONG_WEEKDAY_MS = 6 * DAY_MS;
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

type Day = "today" | "tomorrow" | "week" | "later";

function dayOf(at: Date, now: Date): Day {
  const diff = accraDayStart(at) - accraDayStart(now);
  if (diff <= 0) return "today";
  if (diff === DAY_MS) return "tomorrow";
  return diff <= LONG_WEEKDAY_MS ? "week" : "later";
}

/** "Monday", or "Monday 30 November" when more than 6 days away. */
function dayName(at: Date, day: Day): string {
  const local = new Date(at.getTime() + ACCRA_UTC_OFFSET_MINUTES * MINUTE_MS);
  const name = WEEKDAY_NAMES[local.getUTCDay()];
  return day === "later" ? `${name} ${local.getUTCDate()} ${MONTHS[local.getUTCMonth()]}` : name;
}

function timeOf(at: Date): string {
  return launchClockTime(new Date(at.getTime() + ACCRA_UTC_OFFSET_MINUTES * MINUTE_MS));
}

/** "at 5:00 PM" (today), "tomorrow at 8:00 AM", "on Monday at 8:00 AM". */
export function atWords(at: Date, now: Date): string {
  const day = dayOf(at, now);
  if (day === "today") return `at ${timeOf(at)}`;
  if (day === "tomorrow") return `tomorrow at ${timeOf(at)}`;
  return `on ${dayName(at, day)} at ${timeOf(at)}`;
}

/** "until 5:00 PM" (today), "until tomorrow at 8:00 AM", "until Monday at 8:00 AM". */
export function untilWords(at: Date, now: Date): string {
  const day = dayOf(at, now);
  if (day === "today") return `until ${timeOf(at)}`;
  if (day === "tomorrow") return `until tomorrow at ${timeOf(at)}`;
  return `until ${dayName(at, day)} at ${timeOf(at)}`;
}

/** "We're back at 8:00 AM tomorrow." / "We're back at 2:00 PM." / "We're back on Monday at 8:00 AM." */
export function backAtWords(at: Date, now: Date): string {
  const day = dayOf(at, now);
  if (day === "today") return `We're back at ${timeOf(at)}.`;
  if (day === "tomorrow") return `We're back at ${timeOf(at)} tomorrow.`;
  return `We're back on ${dayName(at, day)} at ${timeOf(at)}.`;
}

export const NO_DRIVERS_TEXT = "No drivers online right now – try again shortly.";
export const SERVICE_CLOSED_TEXT = "CampusRide is closed.";

/** A custom message as a sentence: ends in . ! or ? (so the back-at words can follow). */
function asSentence(message: string): string {
  const trimmed = message.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * What a rider is told when they can't book — the banner on Home and the
 * `error` of the refused POST /rides, which old app builds show as it is:
 * "CampusRide is closed. We're back at 8:00 AM tomorrow." /
 * "Closed for the holiday. We're back on Monday at 8:00 AM." /
 * "No drivers online right now – try again shortly."
 */
export function serviceClosedText(
  state: { reason: ServiceReason; nextOpenAt: Date | null; message: string | null },
  now: Date,
): string {
  if (state.reason === "NO_DRIVERS") return NO_DRIVERS_TEXT;
  const first = state.message?.trim() ? asSentence(state.message) : SERVICE_CLOSED_TEXT;
  if (!state.nextOpenAt) return state.message?.trim() ? first : "CampusRide is closed right now. Please check back later.";
  return `${first} ${backAtWords(state.nextOpenAt, now)}`;
}

/** The admin site's one line for the state in force. */
export function serviceStateLine(state: ServiceState, now: Date): string {
  if (state.reason === "NO_DRIVERS") {
    return "Open hours, but no drivers online – requests are blocked until a driver goes online";
  }
  if (state.open) {
    const label = state.reason === "MANUAL" ? "Open (manual)" : "Open";
    if (!state.closesAt) return state.reason === "MANUAL" ? `${label} until you change it` : `${label} – no closing time ahead`;
    return state.reason === "MANUAL"
      ? `${label} ${untilWords(state.closesAt, now)}`
      : `${label} – closes ${atWords(state.closesAt, now)}`;
  }
  if (state.reason === "MANUAL") {
    return state.nextOpenAt ? `Closed (manual) ${untilWords(state.nextOpenAt, now)}` : "Closed (manual) until you change it";
  }
  return state.nextOpenAt ? `Closed – opens ${atWords(state.nextOpenAt, now)}` : "Closed – no opening hours set";
}

// ─── On a phone ─────────────────────────────────────────────────────────────

/** Riders see "Closes at 5:00 PM" this long before closing. */
export const CLOSING_SOON_MS = 30 * MINUTE_MS;

/** A status as received by a phone, with how far the phone's clock is from the server's. */
export interface HeldServiceStatus {
  status: ServiceStatus;
  exempt: boolean;
  notifyMe: boolean;
  /** Server clock minus phone clock, measured when the answer arrived. */
  clockOffsetMs: number;
}

function isoOrNull(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && !Number.isNaN(Date.parse(value)));
}

function readDayHours(value: unknown): DayHours | null {
  if (!value || typeof value !== "object") return null;
  const { open, close } = value as { open?: unknown; close?: unknown };
  return clockMinutes(open) !== null && clockMinutes(close, { closing: true }) !== null
    ? { open: open as string, close: close as string }
    : null;
}

/** A ServiceStatus from the server or the socket, checked; anything unreadable → null (the app shows no banner). */
export function readServiceStatus(value: unknown): ServiceStatus | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.open !== "boolean" || !(SERVICE_REASONS as readonly unknown[]).includes(v.reason)) return null;
  const nextOpenAt = v.nextOpenAt ?? null;
  const closesAt = v.closesAt ?? null;
  if (!isoOrNull(nextOpenAt) || !isoOrNull(closesAt)) return null;
  return {
    open: v.open,
    reason: v.reason as ServiceReason,
    nextOpenAt,
    closesAt,
    message: typeof v.message === "string" && v.message.trim() ? v.message : null,
    today: readDayHours(v.today),
    serverTime: typeof v.serverTime === "string" && !Number.isNaN(Date.parse(v.serverTime)) ? v.serverTime : "",
  };
}

/** GET /me/service-status's answer, held with the clock offset at `phoneNow`. */
export function holdServiceStatus(
  value: unknown,
  phoneNow: number,
  previous?: Pick<HeldServiceStatus, "exempt" | "notifyMe"> | null,
): HeldServiceStatus | null {
  const status = readServiceStatus(value);
  if (!status) return null;
  const v = value as Record<string, unknown>;
  const serverNow = status.serverTime ? Date.parse(status.serverTime) : phoneNow;
  return {
    status,
    exempt: typeof v.exempt === "boolean" ? v.exempt : (previous?.exempt ?? false),
    notifyMe: typeof v.notifyMe === "boolean" ? v.notifyMe : (previous?.notifyMe ?? false),
    clockOffsetMs: serverNow - phoneNow,
  };
}

export type ServiceView =
  /** Booking works. `closingSoon`: "Closes at 5:00 PM", in the last 30 minutes. */
  | { kind: "open"; closingSoon: string | null }
  /** Closed by the hours or by hand: banner text, and whether "Notify me" fits. */
  | { kind: "closed"; title: string; detail: string | null; nextOpenAt: Date | null }
  | { kind: "noDrivers"; title: string };

/**
 * What the rider app shows at `phoneNow`, on the server's clock. Between
 * answers the times still pass: past `closesAt` it shows closed (until the
 * next answer says when it reopens), past `nextOpenAt` open (the server still
 * decides). Exempt accounts (review demo, admins) always see open.
 */
export function serviceViewAt(held: HeldServiceStatus | null, phoneNow: number): ServiceView {
  if (!held || held.exempt) return { kind: "open", closingSoon: null };
  const { status } = held;
  const now = new Date(phoneNow + held.clockOffsetMs);
  const closesAt = status.closesAt ? new Date(status.closesAt) : null;
  const nextOpenAt = status.nextOpenAt ? new Date(status.nextOpenAt) : null;

  if (status.reason === "NO_DRIVERS") {
    if (closesAt && now >= closesAt) return closedView(null, status.message, now);
    return { kind: "noDrivers", title: NO_DRIVERS_TEXT };
  }
  if (status.open) {
    if (closesAt && now >= closesAt) return closedView(null, status.message, now);
    const soon = closesAt && closesAt.getTime() - now.getTime() <= CLOSING_SOON_MS ? `Closes ${atWords(closesAt, now)}` : null;
    return { kind: "open", closingSoon: soon };
  }
  if (nextOpenAt && now >= nextOpenAt) return { kind: "open", closingSoon: null };
  return closedView(nextOpenAt, status.message, now);
}

function closedView(nextOpenAt: Date | null, message: string | null, now: Date): ServiceView {
  const title = message?.trim() ? asSentence(message) : SERVICE_CLOSED_TEXT;
  return {
    kind: "closed",
    title,
    detail: nextOpenAt ? backAtWords(nextOpenAt, now) : null,
    nextOpenAt,
  };
}

/** The driver app's notice: "Service hours 8:00 AM – 5:00 PM" and, when riders can't book, why. */
export function driverServiceNotice(
  held: HeldServiceStatus | null,
  phoneNow: number,
): { hours: string; blocked: string | null } | null {
  if (!held) return null;
  const { status } = held;
  const hours = status.today ? `Service hours ${dayHoursWords(status.today)}` : "No service hours today";
  // Seen as a rider who isn't exempt (a driver's own exemption doesn't matter here).
  const view = serviceViewAt({ ...held, exempt: false }, phoneNow);
  const blocked =
    view.kind === "open"
      ? null
      : view.kind === "noDrivers"
        ? "Riders can't book until a driver goes online."
        : "Riders can't book right now.";
  return { hours, blocked };
}

/** "We're open!" — the one push to riders who tapped "Notify me when you open". */
export const SERVICE_OPEN_PUSH_TEXT = {
  title: "We're open!",
  body: "Book your ride now.",
} as const;

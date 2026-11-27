/**
 * Scheduled Shared rides (2026-11-27). Pure rules shared by the server (which
 * decides: services/scheduled), the admin site (which edits the numbers) and
 * both apps (which show slots, labels and countdowns), so they never disagree.
 *
 * - A rider books 1–3 seats on a Shared ride for an ARRIVE BY time: a slot
 *   every `slotMinutes` within service hours, today or tomorrow, closing
 *   `bookingCutoffMinutes` before it. Pickup is wherever the rider is.
 * - Bookings in one slot share a car (at most `carSeats` seats) when their
 *   pickups are close (same zone, a neighbour zone, or within
 *   `groupRadiusMeters`) and their drop-offs are the same or neighbour zones.
 * - A car with `offerNowSeats` (3) seats is offered to drivers at once; one
 *   with `offerLaterSeats` (2) at `offerLaterMinutes` (30) before; a 1-seat
 *   car becomes a live request at `soloLiveMinutes` (20) before. A car no
 *   driver accepted by `noDriverMinutes` (25) before becomes live requests.
 * - Accepted: the car is the driver's. More bookings that fit join it (up to
 *   `carSeats`). The driver leaves at "leave by" (arrive-by minus the trip,
 *   the pickups and a buffer); there the car becomes a normal Shared trip.
 * - A driver can't hold two scheduled cars less than `driverGapMinutes` apart.
 * - Cancelling is free until `freeCancelMinutes` before; later cancels and
 *   no-shows are strikes, and `strikesToBlock` strikes in `strikeWindowDays`
 *   stop the rider scheduling for `blockDays`.
 *
 * Times: Africa/Accra, which is UTC all year (service/serviceHours.ts), so a
 * slot is a plain UTC instant and "9:30" is its UTC clock.
 */
import { formatCedis } from "../format/currency";
import { haversineDistanceMeters } from "../geo/distance";
import { serviceStateAt, type ServiceSettings } from "../service/serviceHours";
import { seatsWord } from "./seats";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

// ─── Settings ───────────────────────────────────────────────────────────────

export interface ScheduleSettings {
  /** Riders can schedule at all ("Schedule for later" shows). */
  enabled: boolean;
  /** The "Book your ride ahead" intro shows on fresh launches (rider app). */
  introEnabled: boolean;
  slotMinutes: number;
  bookingCutoffMinutes: number;
  carSeats: number;
  groupRadiusMeters: number;
  offerNowSeats: number;
  offerLaterSeats: number;
  offerLaterMinutes: number;
  soloLiveMinutes: number;
  noDriverMinutes: number;
  driverReminderMinutes: number;
  riderReminderMinutes: number;
  driverGapMinutes: number;
  freeCancelMinutes: number;
  strikesToBlock: number;
  blockDays: number;
  strikeWindowDays: number;
  pickupMinutesPerStop: number;
  leaveBufferMinutes: number;
  pickupWindowMinutes: number;
}

export type ScheduleNumberSetting = Exclude<keyof ScheduleSettings, "enabled" | "introEnabled">;

export const DEFAULT_SCHEDULE_SETTINGS: ScheduleSettings = {
  enabled: true,
  introEnabled: true,
  slotMinutes: 10,
  bookingCutoffMinutes: 20,
  carSeats: 4,
  groupRadiusMeters: 600,
  offerNowSeats: 3,
  offerLaterSeats: 2,
  offerLaterMinutes: 30,
  soloLiveMinutes: 20,
  noDriverMinutes: 25,
  driverReminderMinutes: 10,
  riderReminderMinutes: 10,
  driverGapMinutes: 25,
  freeCancelMinutes: 30,
  strikesToBlock: 2,
  blockDays: 7,
  strikeWindowDays: 30,
  pickupMinutesPerStop: 3,
  leaveBufferMinutes: 5,
  pickupWindowMinutes: 7,
};

/** What each number means, in the order the admin card lists them, with its unit and bounds. */
export const SCHEDULE_SETTING_FIELDS: ReadonlyArray<{
  key: ScheduleNumberSetting;
  label: string;
  unit: "min" | "seats" | "m" | "strikes" | "days";
  min: number;
  max: number;
}> = [
  { key: "slotMinutes", label: "Arrive-by slots every", unit: "min", min: 5, max: 60 },
  { key: "bookingCutoffMinutes", label: "Booking closes before arrive-by", unit: "min", min: 5, max: 120 },
  { key: "carSeats", label: "Seats in a scheduled car", unit: "seats", min: 2, max: 4 },
  { key: "groupRadiusMeters", label: "Pickups grouped within", unit: "m", min: 100, max: 3_000 },
  { key: "offerNowSeats", label: "Offer to drivers at once from", unit: "seats", min: 2, max: 4 },
  { key: "offerLaterSeats", label: "Offer later from", unit: "seats", min: 1, max: 4 },
  { key: "offerLaterMinutes", label: "…offered this long before", unit: "min", min: 10, max: 180 },
  { key: "soloLiveMinutes", label: "1-seat car becomes live request", unit: "min", min: 5, max: 120 },
  { key: "noDriverMinutes", label: "No driver by this long before: live", unit: "min", min: 5, max: 120 },
  { key: "driverReminderMinutes", label: "Driver reminder before leave time", unit: "min", min: 1, max: 60 },
  { key: "riderReminderMinutes", label: "Rider reminder before pickup", unit: "min", min: 1, max: 60 },
  { key: "driverGapMinutes", label: "Driver's scheduled cars at least apart", unit: "min", min: 0, max: 180 },
  { key: "freeCancelMinutes", label: "Free cancel until", unit: "min", min: 0, max: 24 * 60 },
  { key: "strikesToBlock", label: "Strikes that stop scheduling", unit: "strikes", min: 1, max: 10 },
  { key: "blockDays", label: "Stopped for", unit: "days", min: 1, max: 90 },
  { key: "strikeWindowDays", label: "Strikes count for", unit: "days", min: 1, max: 365 },
  { key: "pickupMinutesPerStop", label: "Minutes per pickup (leave-by)", unit: "min", min: 1, max: 15 },
  { key: "leaveBufferMinutes", label: "Spare minutes (leave-by)", unit: "min", min: 0, max: 30 },
  { key: "pickupWindowMinutes", label: "Rider's pickup window", unit: "min", min: 3, max: 30 },
];

/** Why these settings can't be saved, in words, or null. */
export function scheduleSettingsProblem(s: ScheduleSettings): string | null {
  if (typeof s.enabled !== "boolean" || typeof s.introEnabled !== "boolean") return "Say whether scheduling and the intro are on.";
  for (const f of SCHEDULE_SETTING_FIELDS) {
    const v = s[f.key];
    if (!Number.isInteger(v) || v < f.min || v > f.max) return `${f.label}: between ${f.min} and ${f.max} ${f.unit}.`;
  }
  if (60 % s.slotMinutes !== 0) return "Slots must divide the hour (5, 10, 15, 20, 30 or 60 minutes).";
  if (s.offerLaterSeats >= s.offerNowSeats) return "“Offer later from” must be fewer seats than “offer at once from”.";
  if (s.offerNowSeats > s.carSeats) return "“Offer at once from” can't be more than the seats in a car.";
  if (s.offerLaterMinutes <= s.noDriverMinutes) return "Cars must be offered before the “no driver” time.";
  if (s.soloLiveMinutes < s.bookingCutoffMinutes) return "A 1-seat car can't become live before booking closes.";
  if (s.noDriverMinutes < s.bookingCutoffMinutes) return "The “no driver” time can't be after booking closes.";
  return null;
}

/** A stored or sent value read safely: anything missing or wrong is the default. */
export function readScheduleSettings(value: Partial<Record<keyof ScheduleSettings, unknown>> | null | undefined): ScheduleSettings {
  const out: ScheduleSettings = { ...DEFAULT_SCHEDULE_SETTINGS };
  if (!value) return out;
  if (typeof value.enabled === "boolean") out.enabled = value.enabled;
  if (typeof value.introEnabled === "boolean") out.introEnabled = value.introEnabled;
  for (const f of SCHEDULE_SETTING_FIELDS) {
    const v = value[f.key];
    if (typeof v === "number" && Number.isInteger(v)) out[f.key] = v;
  }
  return out;
}

// ─── Clock words (Accra = UTC) ──────────────────────────────────────────────

/** "9:30", "14:10": a scheduled time, Accra clock, 24-hour (the hour strip's numbers). */
export function scheduleClock(at: number | Date | string): string {
  const d = new Date(at);
  return `${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/** The hour (0–23) a slot is in, Accra. */
export function scheduleHour(at: number): number {
  return new Date(at).getUTCHours();
}

/** Start (UTC ms) of the Accra day `at` falls in. */
export function scheduleDayStart(at: number): number {
  return Math.floor(at / DAY_MS) * DAY_MS;
}

export const SCHEDULE_DAYS = ["today", "tomorrow"] as const;
export type ScheduleDay = (typeof SCHEDULE_DAYS)[number];

/** "Today" or "Tomorrow" for a slot (null: neither). */
export function scheduleDayOf(arriveBy: number, now: number): ScheduleDay | null {
  const today = scheduleDayStart(now);
  const day = scheduleDayStart(arriveBy);
  if (day === today) return "today";
  if (day === today + DAY_MS) return "tomorrow";
  return null;
}

export function scheduleDayWord(day: ScheduleDay): string {
  return day === "today" ? "Today" : "Tomorrow";
}

/** "Today 9:30", "Tomorrow 8:00". */
export function scheduleWhen(arriveBy: number, now: number): string {
  const day = scheduleDayOf(arriveBy, now);
  return `${day ? `${scheduleDayWord(day)} ` : ""}${scheduleClock(arriveBy)}`;
}

/** "8:38–8:45". */
export function pickupWindowLabel(window: { start: number; end: number }): string {
  return `${scheduleClock(window.start)}–${scheduleClock(window.end)}`;
}

// ─── Slots ──────────────────────────────────────────────────────────────────

export interface ScheduleSlot {
  arriveBy: number;
  /** Booking still open (until `closesAt`). */
  bookable: boolean;
  closesAt: number;
}

/** When booking for this slot closes. */
export function bookingClosesAt(arriveBy: number, s: ScheduleSettings): number {
  return arriveBy - s.bookingCutoffMinutes * MINUTE_MS;
}

/** Whether CampusRide is open (by its hours, or an admin override then) at this arrive-by time. Drivers online don't matter. */
function servedAt(service: ServiceSettings, at: number): boolean {
  return serviceStateAt(service, new Date(at), 1).open;
}

/**
 * Every arrive-by slot of the Accra day starting at `dayStart`: every
 * `slotMinutes` while CampusRide is open (a slot at the opening minute, none
 * at the closing minute: 8:00 … 16:50 for 08:00–17:00), each marked
 * bookable until its booking closes.
 */
export function slotsForDay(dayStart: number, service: ServiceSettings, s: ScheduleSettings, now: number): ScheduleSlot[] {
  const out: ScheduleSlot[] = [];
  const step = s.slotMinutes * MINUTE_MS;
  for (let t = dayStart; t < dayStart + DAY_MS; t += step) {
    if (!servedAt(service, t)) continue;
    const closesAt = bookingClosesAt(t, s);
    out.push({ arriveBy: t, bookable: now <= closesAt, closesAt });
  }
  return out;
}

/** Today's and tomorrow's slots. */
export function scheduleSlots(service: ServiceSettings, s: ScheduleSettings, now: number): Record<ScheduleDay, ScheduleSlot[]> {
  const today = scheduleDayStart(now);
  return { today: slotsForDay(today, service, s, now), tomorrow: slotsForDay(today + DAY_MS, service, s, now) };
}

/** Why a booking can't be made for this arrive-by time, in words, or null. */
export function slotProblem(
  arriveBy: number,
  service: ServiceSettings,
  s: ScheduleSettings,
  now: number,
  /** Joining a car that already has a driver: open until that car leaves (checked by the caller), not until the cutoff. */
  opts: { lateJoin?: boolean } = {},
): string | null {
  if (!s.enabled) return "Scheduling isn't available right now.";
  if (!Number.isFinite(arriveBy) || arriveBy % (s.slotMinutes * MINUTE_MS) !== 0) return "Choose one of the times shown.";
  if (!scheduleDayOf(arriveBy, now)) return "You can schedule for today or tomorrow.";
  if (!servedAt(service, arriveBy)) return "CampusRide isn't open at that time.";
  if (opts.lateJoin) return now < arriveBy ? null : `${scheduleClock(arriveBy)} has passed. Choose a later time or ride now.`;
  if (now > bookingClosesAt(arriveBy, s)) {
    return `Booking for ${scheduleClock(arriveBy)} has closed. Choose a later time or ride now.`;
  }
  return null;
}

// ─── Grouping ───────────────────────────────────────────────────────────────

export interface ScheduleEnd {
  zoneId: string;
  latitude?: number | null;
  longitude?: number | null;
}

export interface GroupableBooking {
  pickup: ScheduleEnd;
  dropoff: ScheduleEnd;
  seats: number;
}

/** Zone neighbours (either way round). */
export type AreNeighbours = (a: string, b: string) => boolean;

/** Neighbour test from ZoneAdjacency rows (one-way rows count both ways). */
export function neighboursFrom(pairs: ReadonlyArray<{ zoneId: string; adjacentZoneId: string }>): AreNeighbours {
  const set = new Set<string>();
  for (const p of pairs) {
    set.add(`${p.zoneId}|${p.adjacentZoneId}`);
    set.add(`${p.adjacentZoneId}|${p.zoneId}`);
  }
  return (a, b) => set.has(`${a}|${b}`);
}

function metersApart(a: ScheduleEnd, b: ScheduleEnd): number | null {
  if (a.latitude == null || a.longitude == null || b.latitude == null || b.longitude == null) return null;
  return haversineDistanceMeters({ latitude: a.latitude, longitude: a.longitude }, { latitude: b.latitude, longitude: b.longitude });
}

/** Two pickups close enough for one car: same zone, a neighbour zone, or within the radius. */
export function pickupsClose(a: ScheduleEnd, b: ScheduleEnd, neighbours: AreNeighbours, radiusMeters: number): boolean {
  if (a.zoneId === b.zoneId || neighbours(a.zoneId, b.zoneId)) return true;
  const m = metersApart(a, b);
  return m !== null && m <= radiusMeters;
}

/** Two drop-offs one car can do: the same zone or neighbour zones. */
export function dropoffsCompatible(a: ScheduleEnd, b: ScheduleEnd, neighbours: AreNeighbours): boolean {
  return a.zoneId === b.zoneId || neighbours(a.zoneId, b.zoneId);
}

/** Seats booked in a car. */
export function carSeatsBooked(bookings: ReadonlyArray<{ seats: number }>): number {
  return bookings.reduce((sum, b) => sum + b.seats, 0);
}

/** Whether this booking can join a car with these bookings: free seats, and on the way with every one of them. */
export function bookingFitsCar(
  candidate: GroupableBooking,
  car: ReadonlyArray<GroupableBooking>,
  neighbours: AreNeighbours,
  s: ScheduleSettings,
): boolean {
  if (carSeatsBooked(car) + candidate.seats > s.carSeats) return false;
  return car.every(
    (b) =>
      pickupsClose(candidate.pickup, b.pickup, neighbours, s.groupRadiusMeters) &&
      dropoffsCompatible(candidate.dropoff, b.dropoff, neighbours),
  );
}

export interface CarCandidate {
  id: string;
  /** A driver accepted it. */
  accepted: boolean;
  createdAt: number;
  bookings: ReadonlyArray<GroupableBooking>;
}

/**
 * The car a new booking joins, or null for a new car: the one the rider
 * chose ("Join Kofi's car") if it still fits; else a car with a driver
 * first, then the fullest, then the oldest.
 */
export function chooseCar<T extends CarCandidate>(
  cars: readonly T[],
  candidate: GroupableBooking,
  neighbours: AreNeighbours,
  s: ScheduleSettings,
  preferredId?: string | null,
): T | null {
  const fitting = cars.filter((c) => bookingFitsCar(candidate, c.bookings, neighbours, s));
  if (preferredId) {
    const chosen = fitting.find((c) => c.id === preferredId);
    if (chosen) return chosen;
  }
  const sorted = [...fitting].sort(
    (a, b) =>
      Number(b.accepted) - Number(a.accepted) ||
      carSeatsBooked(b.bookings) - carSeatsBooked(a.bookings) ||
      a.createdAt - b.createdAt,
  );
  return sorted[0] ?? null;
}

/**
 * After a slot's booking has closed, a rider can still JOIN a car that has a
 * driver until it leaves: a free seat, on the way (bookingFitsCar: a small
 * detour), and the extra pickup still fits before leave-by (`leaveByWithJoin`
 * at or after now).
 */
export function lateJoinFits(
  car: { leaveBy: number | null; bookings: ReadonlyArray<GroupableBooking> },
  candidate: GroupableBooking,
  neighbours: AreNeighbours,
  s: ScheduleSettings,
  now: number,
  leaveByWithJoin: number,
): boolean {
  if (car.leaveBy === null || now >= car.leaveBy) return false;
  if (!bookingFitsCar(candidate, car.bookings, neighbours, s)) return false;
  return leaveByWithJoin >= now;
}

/** "Need a ride sooner?": the chosen slot is under the cutoff away and there's no car to join. */
export function needsLiveRideInstead(arriveBy: number, now: number, s: Pick<ScheduleSettings, "bookingCutoffMinutes">, hasCarToJoin: boolean): boolean {
  return !hasCarToJoin && arriveBy - now < s.bookingCutoffMinutes * MINUTE_MS;
}

export const SCHEDULE_JOIN_HINT = "Join a car that already has riders. It fills faster and gets confirmed sooner.";
export const SCHEDULE_SOONER_TEXT = "Need a ride sooner? Book a normal ride instead.";

// ─── Dispatch ───────────────────────────────────────────────────────────────

export type OpenCarAction =
  | { action: "WAIT" }
  | { action: "OFFER" }
  | { action: "TO_LIVE"; reason: "ONE_SEAT" | "NO_DRIVER" }
  | { action: "CANCEL" };

/** Minutes from `now` to `at` (negative once past). */
function minutesBefore(at: number, now: number): number {
  return (at - now) / MINUTE_MS;
}

/**
 * What happens now to a car no driver has accepted:
 * - empty: cancelled;
 * - fewer than `offerLaterSeats` (1 seat): live request at `soloLiveMinutes`;
 * - no driver by `noDriverMinutes`: live requests;
 * - `offerNowSeats` or more: offered at once; `offerLaterSeats`: at `offerLaterMinutes`.
 */
export function openCarAction(car: { seats: number; offered: boolean }, arriveBy: number, now: number, s: ScheduleSettings): OpenCarAction {
  if (car.seats <= 0) return { action: "CANCEL" };
  const m = minutesBefore(arriveBy, now);
  if (car.seats < s.offerLaterSeats) return m <= s.soloLiveMinutes ? { action: "TO_LIVE", reason: "ONE_SEAT" } : { action: "WAIT" };
  if (m <= s.noDriverMinutes) return { action: "TO_LIVE", reason: "NO_DRIVER" };
  if (!car.offered && (car.seats >= s.offerNowSeats || m <= s.offerLaterMinutes)) return { action: "OFFER" };
  return { action: "WAIT" };
}

/** When a car of this many seats is (or was) first offered to drivers; null: never (it becomes live). */
export function offerOpensAt(seats: number, arriveBy: number, s: ScheduleSettings): number | null {
  if (seats >= s.offerNowSeats) return Number.NEGATIVE_INFINITY;
  if (seats >= s.offerLaterSeats) return arriveBy - s.offerLaterMinutes * MINUTE_MS;
  return null;
}

/**
 * When the driver sets off: arrive-by less the trip, a few minutes per pickup
 * and spare minutes. Never earlier than `notBefore` (now, for a late join).
 */
export function leaveByFor(arriveBy: number, tripMinutes: number, pickups: number, s: ScheduleSettings, notBefore = Number.NEGATIVE_INFINITY): number {
  const minutes = Math.max(1, Math.round(tripMinutes)) + Math.max(1, pickups) * s.pickupMinutesPerStop + s.leaveBufferMinutes;
  // Whole minutes, so the shown time and the reminder agree.
  const at = Math.floor((arriveBy - minutes * MINUTE_MS) / MINUTE_MS) * MINUTE_MS;
  return Math.max(at, notBefore);
}

/** The window a rider should be ready in: from leave-by, at least `pickupWindowMinutes`, longer with many pickups. */
export function pickupWindowFor(leaveBy: number, pickups: number, s: ScheduleSettings): { start: number; end: number } {
  const minutes = Math.max(s.pickupWindowMinutes, Math.max(1, pickups) * s.pickupMinutesPerStop);
  return { start: leaveBy, end: leaveBy + minutes * MINUTE_MS };
}

/** When the rider's reminder goes ("be ready"). */
export function riderReminderAt(window: { start: number }, s: ScheduleSettings): number {
  return window.start - s.riderReminderMinutes * MINUTE_MS;
}

/** When the driver's reminder goes ("leave in 10 minutes"). */
export function driverReminderAt(leaveBy: number, s: ScheduleSettings): number {
  return leaveBy - s.driverReminderMinutes * MINUTE_MS;
}

/** A driver's scheduled cars must be at least `driverGapMinutes` apart: true when this one is too close to one they hold. */
export function scheduleOverlaps(arriveBy: number, held: readonly number[], s: ScheduleSettings): boolean {
  return held.some((other) => Math.abs(other - arriveBy) < s.driverGapMinutes * MINUTE_MS);
}

export function scheduleOverlapText(s: ScheduleSettings): string {
  return `You already have a scheduled trip within ${s.driverGapMinutes} minutes of this one.`;
}

// ─── Cancels and strikes ────────────────────────────────────────────────────

/** Until when cancelling is free. */
export function freeCancelUntil(arriveBy: number, s: ScheduleSettings): number {
  return arriveBy - s.freeCancelMinutes * MINUTE_MS;
}

export function cancelIsFree(arriveBy: number, now: number, s: ScheduleSettings): boolean {
  return now <= freeCancelUntil(arriveBy, s);
}

/** True when a rider with this many strikes (in the window, since any last block) is stopped from scheduling. */
export function strikesBlock(strikes: number, s: ScheduleSettings): boolean {
  return strikes >= s.strikesToBlock;
}

/** The earliest strike that still counts: in the window, and after the last block began. */
export function strikesCountFrom(now: number, s: ScheduleSettings, lastBlockAt: number | null): number {
  return Math.max(now - s.strikeWindowDays * DAY_MS, lastBlockAt ?? Number.NEGATIVE_INFINITY);
}

export function scheduleBlockUntil(now: number, s: ScheduleSettings): number {
  return now + s.blockDays * DAY_MS;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** "Thu 4 Dec, 9:30" (Accra). */
export function scheduleDateWords(at: number): string {
  const d = new Date(at);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${scheduleClock(at)}`;
}

/** What a stopped rider is told (the schedule screen and a refused booking). */
export function scheduleBlockedText(until: number, s: Pick<ScheduleSettings, "strikesToBlock">): string {
  return `You can't schedule rides until ${scheduleDateWords(until)}, after ${s.strikesToBlock} late cancels or missed pickups. You can still ride now.`;
}

/** The cancel sheet's warning: free, or a strike (and whether it stops scheduling). */
export function scheduleCancelText(arriveBy: number, now: number, s: ScheduleSettings, strikesSoFar: number): string {
  if (cancelIsFree(arriveBy, now, s)) return "Cancelling is free.";
  const last = strikesBlock(strikesSoFar + 1, s);
  return last
    ? `It's less than ${s.freeCancelMinutes} minutes to go, so this counts as a strike and you won't be able to schedule for ${s.blockDays} days.`
    : `It's less than ${s.freeCancelMinutes} minutes to go, so this counts as a strike. ${s.strikesToBlock} strikes stop scheduling for ${s.blockDays} days.`;
}

// ─── Words ──────────────────────────────────────────────────────────────────

export const SCHEDULE_FINDING_NOW_TEXT = "We're finding you a driver now";
export const SCHEDULE_NEW_DRIVER_TEXT = "Finding you a new driver";

/** The offer drivers see: "Scheduled · 9:30 · 3 seats · GH₵21". */
export function scheduledOfferLabel(arriveBy: number, seats: number, farePesewas: number): string {
  return `Scheduled · ${scheduleClock(arriveBy)} · ${seatsWord(seats)} · ${formatCedis(farePesewas)}`;
}

/** "Join Kofi's car · 1 seat left". */
export function joinCarLabel(driverFirstName: string, seatsLeft: number): string {
  return `Join ${driverFirstName}'s car · ${seatsWord(seatsLeft)} left`;
}

/** "9:00 · 2 going". */
export function goingLabel(arriveBy: number, going: number): string {
  return `${scheduleClock(arriveBy)} · ${going} going`;
}

/** The main button: "Reserve seat · 9:00 · GH₵7", "Reserve 2 seats · 9:00 · GH₵14". */
export function reserveButtonLabel(arriveBy: number, seats: number, farePesewas: number): string {
  const what = seats > 1 ? `Reserve ${seats} seats` : "Reserve seat";
  return `${what} · ${scheduleClock(arriveBy)} · ${formatCedis(farePesewas)}`;
}

/** "3 of 4 seats filled". */
export function seatsFilledLabel(taken: number, capacity: number): string {
  return `${Math.min(taken, capacity)} of ${capacity} seats filled`;
}

export const SCHEDULED_BOOKING_STATES = ["WAITING_FOR_RIDERS", "CAR_CONFIRMED", "DRIVER_ON_THE_WAY", "FINDING_DRIVER"] as const;
export type ScheduledBookingState = (typeof SCHEDULED_BOOKING_STATES)[number];

export const SCHEDULED_STATE_LABELS: Record<ScheduledBookingState, string> = {
  WAITING_FOR_RIDERS: "Waiting for riders",
  CAR_CONFIRMED: "Car confirmed",
  DRIVER_ON_THE_WAY: "Driver on the way",
  FINDING_DRIVER: SCHEDULE_FINDING_NOW_TEXT,
};

/** "Leave by 8:38". */
export function leaveByLabel(leaveBy: number): string {
  return `Leave by ${scheduleClock(leaveBy)}`;
}

// ─── Wire shapes ────────────────────────────────────────────────────────────

export const SCHEDULE_PATHS = {
  /** POST: slots and cars going the rider's way for a trip (body: ends + seats). */
  options: "/rides/scheduled/options",
  /** POST: book; GET …/mine: the rider's upcoming booking. */
  book: "/rides/scheduled",
  mine: "/rides/scheduled/mine",
  /** POST …/:id/cancel, …/:id/coming. */
  booking: (id: string) => `/rides/scheduled/${encodeURIComponent(id)}`,
  /** GET: the driver's Schedule tab. */
  driver: "/driver/scheduled",
  /** POST …/:id/accept, …/:id/cancel. */
  driverCar: (id: string) => `/driver/scheduled/${encodeURIComponent(id)}`,
} as const;

/** Socket events: to a driver (an offer, their Schedule tab changed) and to a rider (their booking changed). */
export const SCHEDULE_EVENTS = {
  OFFER: "driver:scheduled_offer",
  DRIVER_CHANGED: "driver:schedule_changed",
  RIDER_CHANGED: "rider:schedule_changed",
} as const;

/** Notification action on the rider's reminder ("I'm coming"), and its category. */
export const SCHEDULE_REMINDER_CATEGORY = "scheduled-reminder";
export const SCHEDULE_COMING_ACTION = "coming";

export const SCHEDULE_ACCEPTED_VIA = ["POPUP", "BOARD", "SCHEDULE"] as const;
export type ScheduleAcceptedVia = (typeof SCHEDULE_ACCEPTED_VIA)[number];

export interface ScheduleSlotView {
  /** ISO time. */
  arriveBy: string;
  bookable: boolean;
  /** Seats already booked in cars going the rider's way with room for them. */
  going: number;
  /** A car with a driver the rider can join, if any. */
  join: { carId: string; driverFirstName: string; seatsLeft: number } | null;
}

export interface ScheduleOptions {
  enabled: boolean;
  /** Stopped from scheduling until then (ISO), with the words to show. */
  blockedUntil: string | null;
  blockedText: string | null;
  days: Array<{ day: ScheduleDay; slots: ScheduleSlotView[] }>;
  /** The price for 1, 2 and 3 seats on this trip (same as now). */
  sharedBySeats: [number, number, number];
  farTrip: boolean;
  settings: Pick<ScheduleSettings, "slotMinutes" | "bookingCutoffMinutes" | "freeCancelMinutes" | "carSeats">;
  serverTime: string;
}

export interface ScheduledBookingView {
  id: string;
  carId: string;
  arriveBy: string;
  status: "BOOKED" | "STARTED" | "LIVE" | "CANCELLED";
  state: ScheduledBookingState;
  seats: number;
  farePesewas: number;
  carSeatsTaken: number;
  carSeats: number;
  pickupLabel: string;
  dropoffLabel: string;
  driver: { firstName: string; carColor: string | null; carMake: string | null; carModel: string | null; plate: string | null; photoUrl: string | null } | null;
  pickupWindow: { start: string; end: string } | null;
  freeCancelUntil: string;
  coming: boolean;
  /** The trip or live request it became (open it to track the driver). */
  rideId: string | null;
  serverTime: string;
}

export interface DriverScheduledRider {
  firstName: string;
  seats: number;
  pickupLabel: string;
  dropoffLabel: string;
  coming: boolean;
}

export interface DriverScheduledCarView {
  carId: string;
  arriveBy: string;
  leaveBy: string | null;
  status: "OPEN" | "ACCEPTED" | "STARTED";
  seats: number;
  carSeats: number;
  farePesewas: number;
  driverSharePesewas: number;
  pickupArea: string;
  dropoffArea: string;
  label: string;
  /** This driver holds it. */
  mine: boolean;
  canAccept: boolean;
  /** Why not, in words. */
  note: string | null;
  /** Riders (own cars only: first names and place names, never pins). */
  riders: DriverScheduledRider[];
  rideId: string | null;
}

export interface DriverScheduleResponse {
  online: boolean;
  mine: DriverScheduledCarView[];
  open: DriverScheduledCarView[];
  serverTime: string;
}

// ─── The rider app's "Book your ride ahead" intro ───────────────────────────

/** The intro stops showing this many days after it first showed. */
export const SCHEDULE_INTRO_DAYS = 5;

/**
 * Whether the intro shows on this launch: a FRESH launch only (not a return
 * from the background), at most once per launch, while the server allows it
 * (scheduling and the admin switch on, the rider has never booked a
 * scheduled ride), the rider hasn't tapped "Don't show again", and it's
 * under SCHEDULE_INTRO_DAYS since it first showed.
 */
export function shouldShowScheduleIntro(input: {
  serverShow: boolean;
  freshLaunch: boolean;
  shownThisLaunch: boolean;
  dismissedForever: boolean;
  firstShownAt: number | null;
  now: number;
}): boolean {
  if (!input.serverShow || !input.freshLaunch || input.shownThisLaunch || input.dismissedForever) return false;
  return input.firstShownAt === null || input.now - input.firstShownAt < SCHEDULE_INTRO_DAYS * DAY_MS;
}

export const SCHEDULE_INTRO_STEPS = [
  { key: "ahead", title: "Schedule ahead", body: "Pick the time you need to arrive. Tonight for tomorrow, or later today." },
  { key: "join", title: "Join a car going your way", body: "Share with students heading the same way. From GH₵7." },
  { key: "ontime", title: "Picked up on time", body: "Your driver is confirmed early, and we remind you before pickup." },
] as const;

// ─── The schedule screen ────────────────────────────────────────────────────

/** The hours (0–23) that still have a slot to show: a slot not yet past. */
export function scheduleHours(slots: readonly ScheduleSlotView[], now: number): number[] {
  const hours = new Set<number>();
  for (const s of slots) {
    const at = Date.parse(s.arriveBy);
    if (at > now) hours.add(scheduleHour(at));
  }
  return [...hours].sort((a, b) => a - b);
}

/** The slots of one hour (6 for 10-minute slots), past ones included so the grid keeps its shape. */
export function slotsInHour(slots: readonly ScheduleSlotView[], hour: number): ScheduleSlotView[] {
  return slots.filter((s) => scheduleHour(Date.parse(s.arriveBy)) === hour);
}

export interface JoinChip {
  arriveBy: string;
  label: string;
  carId: string | null;
}

/**
 * "Join a car" chips: bookable slots with people going the rider's way —
 * cars with a driver first ("Join Kofi's car · 1 seat left"), then the rest
 * by time ("9:00 · 2 going"). At most `limit`.
 */
export function joinChips(slots: readonly ScheduleSlotView[], limit = 6): JoinChip[] {
  const open = slots.filter((s) => s.bookable && (s.join || s.going > 0));
  const withDriver = open.filter((s) => s.join);
  const rest = open.filter((s) => !s.join);
  return [...withDriver, ...rest].slice(0, limit).map((s) => ({
    arriveBy: s.arriveBy,
    carId: s.join?.carId ?? null,
    label: s.join ? `${scheduleClock(s.arriveBy)} · ${joinCarLabel(s.join.driverFirstName, s.join.seatsLeft)}` : goingLabel(Date.parse(s.arriveBy), s.going),
  }));
}

/** The first slot to show selected: the first chip, else the first bookable slot. */
export function firstChoice(slots: readonly ScheduleSlotView[]): ScheduleSlotView | null {
  return slots.find((s) => s.bookable && s.join) ?? slots.find((s) => s.bookable && s.going > 0) ?? slots.find((s) => s.bookable) ?? null;
}

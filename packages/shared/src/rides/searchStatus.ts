import { formatCedis } from "../format/currency";
import { getSharedFarePerRider } from "../pricing/pricing";
import type { NearbyCar } from "./nearbyCars";

/**
 * The rider's "Finding your driver" screen (2026-11-26): what the search is
 * really doing, so the wait feels like progress instead of a clock counting
 * up with no end. Day 3: a third of riders cancelled while searching, mostly
 * "waiting too long", after a median of 1.9 minutes.
 *
 * The server sends a RideSearchStatus (GET /rides/:id/search-status, and the
 * `ride:search_status` socket event to the rider's own room) built from what
 * dispatch actually did. Every number on the screen comes from it; when a
 * number isn't known the wording has none. The step timings below are
 * presentation only: the request reached drivers the moment it was made, and
 * an accept ends the screen at once, at any step.
 */

export const searchStatusPath = (rideId: string) => `/rides/${encodeURIComponent(rideId)}/search-status`;

/** How often the screen asks again while it is on show (the socket brings changes sooner). */
export const SEARCH_STATUS_POLL_MS = 10_000;

/** Where the request went: drivers near the pickup, or (nobody free there) every driver on campus. */
export type SearchScope = "nearby" | "campus";

export interface SearchWaitRange {
  fromMinutes: number;
  toMinutes: number;
}

export interface RideSearchStatus {
  rideId: string;
  /** When this search began (the ride's broadcastStartedAt), ISO; the steps are timed from it. */
  searchStartedAt: string | null;
  /** Drivers this search was shown to (pop-up, list or trip screen). Null: not known. */
  driversOffered: number | null;
  /** Of those, the ones who still have it (didn't decline). Null: not known. */
  driversWithIt: number | null;
  scope: SearchScope | null;
  /** Live drivers whose car dispatch looked at for this request. Null: not known. */
  carsChecked: number | null;
  /** The nearest live car with a free seat (that didn't decline it), rounded to 100 m. Null: none. */
  nearestFreeCarMeters: number | null;
  /** Live drivers busy on trips: near the pickup, elsewhere on campus, or none. */
  driversOnTrips: SearchScope | null;
  /** No request near this pickup has been waiting longer. */
  firstInLine: boolean;
  /** Median to 75th percentile time to a driver's accept over the last 7 days. Null: too few. */
  usualWait: SearchWaitRange | null;
  /** The free wait at pickup now (admin setting), in seconds. Null: not known. */
  freeWaitSeconds: number | null;
  /** Approximate cars for the map, as GET /rides/nearby-cars: no driver id, position moved 10-25 m. */
  cars: NearbyCar[];
}

// ── Server-side rules ─────────────────────────────────────────────────────

/** Accepted requests needed in the last 7 days before a "usually" range is shown. */
export const USUAL_WAIT_MIN_SAMPLES = 5;
export const USUAL_WAIT_DAYS = 7;

/**
 * "Usually 1–3 min" from the median and 75th percentile time to accept,
 * rounded to whole minutes; never less than "1–2 min", and the top always
 * above the bottom.
 */
export function usualWaitRange(medianSeconds: number, p75Seconds: number): SearchWaitRange | null {
  if (!Number.isFinite(medianSeconds) || !Number.isFinite(p75Seconds)) return null;
  const fromMinutes = Math.max(1, Math.round(medianSeconds / 60));
  const toMinutes = Math.max(fromMinutes + 1, Math.round(Math.max(medianSeconds, p75Seconds) / 60));
  return { fromMinutes, toMinutes };
}

/** A distance as the screen says it: to the nearest 100 m, and never "0 m". */
export function roundToHundredMeters(meters: number): number {
  return Math.max(100, Math.round(meters / 100) * 100);
}

// ── What the screen says ──────────────────────────────────────────────────

/** When each step is shown done, from the start of the search (presentation only). */
export const SEARCH_STEP_DONE_MS = { send: 5_000, offer: 20_000, check: 45_000 } as const;
/** From here, the "drivers are finishing trips" line may show. */
export const FINISHING_TRIPS_AFTER_MS = 150_000;
/** Each tip shows for this long. */
export const SEARCH_TIP_MS = 6_000;

export type SearchStepKey = "send" | "offer" | "check" | "accept";
export type SearchStepState = "pending" | "active" | "done";

export interface SearchStepView {
  key: SearchStepKey;
  state: SearchStepState;
  /** What the row says now. */
  label: string;
  /** Every wording this row can take, so it can keep one height whichever shows. */
  labels: readonly string[];
  /**
   * A second line ("Usually 1–3 min"), or null. Given before the step is
   * reached too, so the screen can keep room for it; show it only once the
   * step is active.
   */
  detail: string | null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function offerDone(status: RideSearchStatus | null, near: string): string {
  const n = status?.driversOffered ?? null;
  const where = status?.scope === "campus" ? "on campus" : "nearby";
  if (n === null) return `Searched for drivers near ${near}`;
  if (n === 0) return `No driver free ${where} yet`;
  return `Shown to ${plural(n, "driver", "drivers")} ${where}`;
}

function checkDone(status: RideSearchStatus | null): string {
  const m = status?.carsChecked ?? null;
  if (m === null) return "Cars checked";
  if (m === 0) return "No free cars yet";
  return `${plural(m, "car", "cars")} checked`;
}

/**
 * The four steps at `elapsedMs` into the search. Each is "active" (a
 * spinner) for its slot, then "done" (a tick); the last one, waiting for an
 * accept, stays active until a driver accepts — which ends the screen.
 */
export function searchSteps(
  elapsedMs: number,
  status: RideSearchStatus | null,
  pickupName: string | null,
): SearchStepView[] {
  const near = pickupName?.trim() || "you";
  const t = Math.max(0, elapsedMs);
  const stateOf = (start: number, done: number | null): SearchStepState =>
    t < start ? "pending" : done !== null && t >= done ? "done" : "active";

  const sendActive = "Sending your request…";
  const offerActive = `Finding drivers near ${near}…`;
  const checkActive = "Checking cars with free seats going your way…";
  const wait = status?.usualWait ?? null;

  const steps: Array<Omit<SearchStepView, "label"> & { active: string; done: string }> = [
    {
      key: "send",
      state: stateOf(0, SEARCH_STEP_DONE_MS.send),
      active: sendActive,
      done: "Request sent",
      labels: [],
      detail: null,
    },
    {
      key: "offer",
      state: stateOf(SEARCH_STEP_DONE_MS.send, SEARCH_STEP_DONE_MS.offer),
      active: offerActive,
      done: offerDone(status, near),
      labels: [],
      detail: null,
    },
    {
      key: "check",
      state: stateOf(SEARCH_STEP_DONE_MS.offer, SEARCH_STEP_DONE_MS.check),
      active: checkActive,
      done: checkDone(status),
      labels: [],
      detail: null,
    },
    {
      key: "accept",
      state: stateOf(SEARCH_STEP_DONE_MS.check, null),
      active: "Waiting for a driver to accept",
      done: "Waiting for a driver to accept",
      labels: [],
      detail: wait ? `Usually ${wait.fromMinutes}–${wait.toMinutes} min` : null,
    },
  ];
  return steps.map(({ active, done, ...step }) => ({
    ...step,
    label: step.state === "done" ? done : active,
    labels: active === done ? [active] : [active, done],
  }));
}

/** "300 m", "1.2 km". */
export function distanceWords(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`;
  const km = Math.round(meters / 100) / 10;
  return `${Number.isInteger(km) ? km.toFixed(0) : km.toFixed(1)} km`;
}

/**
 * One live line under the steps, or null. From 2:30, while live drivers are
 * busy on trips: they are finishing them (and, only when it's true, that
 * this rider is still first in line). Otherwise, once the request is out,
 * how far the nearest car with a free seat is.
 */
export function searchLiveNote(elapsedMs: number, status: RideSearchStatus | null): string | null {
  if (!status) return null;
  if (elapsedMs >= FINISHING_TRIPS_AFTER_MS && status.driversOnTrips) {
    const finishing =
      status.driversOnTrips === "nearby" ? "Drivers are finishing nearby trips." : "Drivers are finishing trips on campus.";
    return status.firstInLine ? `${finishing} You're still first in line.` : finishing;
  }
  if (elapsedMs >= SEARCH_STEP_DONE_MS.send && status.nearestFreeCarMeters !== null) {
    return `A car with a free seat is ${distanceWords(status.nearestFreeCarMeters)} away`;
  }
  return null;
}

/** "2½ min", "2 min", "1 min 40 s". */
export function freeWaitWords(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (rest === 0) return `${m} min`;
  if (rest === 30) return m === 0 ? "30 s" : `${m}½ min`;
  return m === 0 ? `${rest} s` : `${m} min ${rest} s`;
}

/**
 * The tips at the bottom of the screen, in order. The free-wait tip says the
 * free wait in force now, and is left out when the app doesn't know it.
 */
export function searchTips(status: RideSearchStatus | null): string[] {
  const tips = ["We'll notify you as soon as a driver accepts"];
  if (status?.freeWaitSeconds) tips.push(`Be at the pickup: drivers wait ${freeWaitWords(status.freeWaitSeconds)} free`);
  tips.push(`Shared rides from ${formatCedis(getSharedFarePerRider(1))}`);
  tips.push("Tip: shared rides fill up fastest near busy halls");
  return tips;
}

/** The cancel question's second line: "3 drivers have it." Null when there's no real number to give. */
export function cancelSearchLine(status: RideSearchStatus | null): string | null {
  const n = status?.driversWithIt ?? null;
  if (n === null || n <= 0) return null;
  return n === 1 ? "1 driver has it." : `${n} drivers have it.`;
}

// ── Reading it (apps) ─────────────────────────────────────────────────────

const count = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
const scopeOf = (v: unknown): SearchScope | null => (v === "nearby" || v === "campus" ? v : null);

function carOf(v: unknown): NearbyCar | null {
  if (typeof v !== "object" || v === null) return null;
  const c = v as Record<string, unknown>;
  if (typeof c.key !== "string" || !Number.isFinite(c.latitude) || !Number.isFinite(c.longitude)) return null;
  if (!(c.heading === null || Number.isFinite(c.heading))) return null;
  return { key: c.key, latitude: c.latitude as number, longitude: c.longitude as number, heading: c.heading as number | null };
}

/** A RideSearchStatus from the wire, or null; any field that doesn't check out reads as "not known". */
export function parseRideSearchStatus(raw: unknown): RideSearchStatus | null {
  if (typeof raw !== "object" || raw === null) return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.rideId !== "string" || s.rideId.length === 0) return null;
  const wait = s.usualWait as Record<string, unknown> | null | undefined;
  const from = count(wait?.fromMinutes);
  const to = count(wait?.toMinutes);
  const nearest = s.nearestFreeCarMeters;
  return {
    rideId: s.rideId,
    searchStartedAt:
      typeof s.searchStartedAt === "string" && !Number.isNaN(Date.parse(s.searchStartedAt)) ? s.searchStartedAt : null,
    driversOffered: count(s.driversOffered),
    driversWithIt: count(s.driversWithIt),
    scope: scopeOf(s.scope),
    carsChecked: count(s.carsChecked),
    nearestFreeCarMeters: typeof nearest === "number" && Number.isFinite(nearest) && nearest > 0 ? nearest : null,
    driversOnTrips: scopeOf(s.driversOnTrips),
    firstInLine: s.firstInLine === true,
    usualWait: from !== null && to !== null && from >= 1 && to > from ? { fromMinutes: from, toMinutes: to } : null,
    freeWaitSeconds: count(s.freeWaitSeconds) || null,
    cars: Array.isArray(s.cars) ? s.cars.map(carOf).filter((c): c is NearbyCar => c !== null) : [],
  };
}

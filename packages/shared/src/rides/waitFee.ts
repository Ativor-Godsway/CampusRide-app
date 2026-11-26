/**
 * The pickup wait fee (2026-11-25). Pure rules shared by the server and both
 * apps, so the countdown, the fee and the fare to collect agree everywhere.
 *
 * - The driver's "arrived" at a rider's pickup starts that rider's FREE WAIT
 *   (2:30 by default), but only if the driver's GPS is within
 *   WAIT_TIMER_RADIUS_METERS of the pickup. Otherwise the driver is told to
 *   get closer, and there is no timer (and so no fee) yet.
 * - Not picked up by the end of the free wait: a flat WAIT FEE (GH 2 by
 *   default) is added to THAT rider's seat, once. Other riders in the car are
 *   not affected. The 85/15 split applies to the whole fare, fee included.
 * - Fair warning: the fee is owed only if the rider was warned before the
 *   free wait ended: the arrival push (which states the free wait and the
 *   fee) was accepted for delivery, or their app shows the countdown.
 * - "Rider didn't show" opens only after the no-show wait (5 min by
 *   default); a no-show pays nothing (cash), it is only recorded.
 *
 * The three numbers are admin settings (server: services/ride/waitFee.ts),
 * copied onto the seat when the timer starts, so a change never alters a
 * wait already running.
 */
import { formatCedis } from "../format/currency";

/** "Arrived" starts the wait timer only this close (metres) to the rider's pickup. */
export const WAIT_TIMER_RADIUS_METERS = 100;

/**
 * Request header the apps send to say which features their JavaScript has
 * (comma-separated). "wait-fee": this app shows the wait timer and fee.
 */
export const CLIENT_FEATURES_HEADER = "x-campusride-features";
export const WAIT_FEE_FEATURE = "wait-fee";

/** True when a features header value lists `feature`. */
export function hasClientFeature(header: string | string[] | undefined, feature: string): boolean {
  const value = Array.isArray(header) ? header.join(",") : (header ?? "");
  return value
    .split(",")
    .map((f) => f.trim().toLowerCase())
    .includes(feature);
}

export interface WaitFeeSettings {
  /** The free wait, from the start of the timer. */
  freeWaitSeconds: number;
  /** Added to the rider's fare after it, in pesewas. 0 = no wait fee. */
  feePesewas: number;
  /** "Rider didn't show" opens after this much waiting. */
  noShowMinutes: number;
}

export const DEFAULT_WAIT_FEE_SETTINGS: WaitFeeSettings = {
  freeWaitSeconds: 150,
  feePesewas: 200,
  noShowMinutes: 5,
};

export const WAIT_FEE_BOUNDS = {
  freeWaitSeconds: { min: 30, max: 900 },
  feePesewas: { min: 0, max: 2_000 },
  noShowMinutes: { min: 1, max: 30 },
} as const;

/** Why these settings can't be saved, or null. */
export function waitFeeSettingsProblem(s: WaitFeeSettings): string | null {
  const b = WAIT_FEE_BOUNDS;
  const inRange = (v: number, r: { min: number; max: number }) => Number.isInteger(v) && v >= r.min && v <= r.max;
  if (!inRange(s.freeWaitSeconds, b.freeWaitSeconds)) return "The free wait must be from 30 seconds to 15 minutes, in whole seconds.";
  if (!inRange(s.feePesewas, b.feePesewas)) return `The wait fee must be from ${formatCedis(0)} to ${formatCedis(b.feePesewas.max)}.`;
  if (!inRange(s.noShowMinutes, b.noShowMinutes)) return "The no-show wait must be from 1 to 30 whole minutes.";
  if (s.noShowMinutes * 60 < s.freeWaitSeconds) return "The no-show wait can't be shorter than the free wait.";
  return null;
}

/** "2:30" for 150 s; "0:05". */
export function waitClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** The arrival push's body: "Your driver has arrived. Free wait: 2:30, then GH 2 extra." */
export function arrivedWithWaitText(freeWaitSeconds: number, feePesewas: number): string {
  return `Your driver has arrived. Free wait: ${waitClock(freeWaitSeconds * 1000)}, then ${formatCedis(feePesewas)} extra.`;
}

/**
 * A rider's pickup wait as the apps get it: on their seat while it is
 * ARRIVED (null otherwise; older servers send none).
 */
export interface SeatWait {
  /** False: the driver marked arrival but wasn't close enough, so no timer (and no fee). */
  timerStarted: boolean;
  /** ISO times; null until the timer starts. */
  startedAt: string | null;
  freeUntil: string | null;
  /** Added to this rider's fare once the free wait is over; null when no fee can apply. */
  feePesewas: number | null;
}

export type WaitPhase = "NOT_STARTED" | "FREE" | "OVER";

export interface WaitView {
  phase: WaitPhase;
  /** Of the free wait (0 once over). */
  freeLeftMs: number;
  /** Since the timer started; null before. */
  waitedMs: number | null;
  /** The fee that applies (now or once the free wait is over); null = none. */
  feePesewas: number | null;
  /** The fee already added to the fare now: feePesewas once OVER, else 0. */
  addedPesewas: number;
}

/** What the wait looks like at `nowMs` (null: no wait to show). */
export function waitView(wait: SeatWait | null | undefined, nowMs: number): WaitView | null {
  if (!wait) return null;
  const start = wait.startedAt ? Date.parse(wait.startedAt) : NaN;
  const end = wait.freeUntil ? Date.parse(wait.freeUntil) : NaN;
  if (!wait.timerStarted || !Number.isFinite(start) || !Number.isFinite(end)) {
    return { phase: "NOT_STARTED", freeLeftMs: 0, waitedMs: null, feePesewas: null, addedPesewas: 0 };
  }
  const over = nowMs >= end;
  const fee = wait.feePesewas && wait.feePesewas > 0 ? wait.feePesewas : null;
  return {
    phase: over ? "OVER" : "FREE",
    freeLeftMs: over ? 0 : end - nowMs,
    waitedMs: Math.max(0, nowMs - start),
    feePesewas: fee,
    addedPesewas: over && fee ? fee : 0,
  };
}

/**
 * The seat's fare now: its stored fare (which already includes a wait fee
 * charged at pickup) plus a fee that is due but not charged yet (the rider
 * still at the pickup after the free wait).
 */
export function fareWithWait(lockedFare: number | null, wait: SeatWait | null | undefined, nowMs: number): number | null {
  if (lockedFare === null) return null;
  return lockedFare + (waitView(wait, nowMs)?.addedPesewas ?? 0);
}

// ─── Server side: the seat's stored columns ─────────────────────────────────

export interface StoredSeatWait {
  waitStartedAt: Date | null;
  freeWaitEndsAt: Date | null;
  waitFeeAmount: number | null;
  riderWarnedAt: Date | null;
}

/** The fee this seat owes if the rider is still at the pickup at `at` (0 if none). */
export function waitFeeDue(seat: StoredSeatWait, at: Date): number {
  if (!seat.freeWaitEndsAt || !seat.waitFeeAmount || seat.waitFeeAmount <= 0) return 0;
  if (!seat.riderWarnedAt || seat.riderWarnedAt > seat.freeWaitEndsAt) return 0;
  return at >= seat.freeWaitEndsAt ? seat.waitFeeAmount : 0;
}

/** The seat's wait for the apps (only while ARRIVED). */
export function seatWaitForApp(seat: StoredSeatWait & { status: string }): SeatWait | null {
  if (seat.status !== "ARRIVED") return null;
  if (!seat.waitStartedAt || !seat.freeWaitEndsAt) {
    return { timerStarted: false, startedAt: null, freeUntil: null, feePesewas: null };
  }
  const warned = !!seat.riderWarnedAt && seat.riderWarnedAt <= seat.freeWaitEndsAt;
  return {
    timerStarted: true,
    startedAt: seat.waitStartedAt.toISOString(),
    freeUntil: seat.freeWaitEndsAt.toISOString(),
    feePesewas: warned && seat.waitFeeAmount && seat.waitFeeAmount > 0 ? seat.waitFeeAmount : null,
  };
}

/**
 * How long a request searches for a driver before the rider is told no
 * driver was found (REQUESTED -> AWAITING_RIDER_DECISION). An admin setting
 * since 2026-11-25 (Settings → Ride requests), 7 minutes by default (2
 * minutes before; riders gave up at the 2-minute "no driver yet" screen).
 * The server enforces it (services/ride/searchWindow.ts, timeouts.ts).
 *
 * The offer pop-up is separate: it still counts down for DRIVER_OFFER_SECONDS
 * (offerDeadline), and the request stays on the drivers' request board and
 * lists for the whole window.
 */
export const DEFAULT_SEARCH_WINDOW_SECONDS = 420;
/** What an admin may set: 1 to 30 minutes. */
export const SEARCH_WINDOW_BOUNDS_SECONDS = { min: 60, max: 1_800 } as const;

/**
 * The default window in ms. Apps use it only as a fallback when a server
 * sends no `expiresAt`; the server itself reads the admin setting.
 */
export const DISPATCH_WINDOW_MS = DEFAULT_SEARCH_WINDOW_SECONDS * 1000;

/** Why a search window can't be saved, or null. */
export function searchWindowProblem(seconds: number): string | null {
  const { min, max } = SEARCH_WINDOW_BOUNDS_SECONDS;
  if (!Number.isInteger(seconds) || seconds < min || seconds > max) return "The search window must be from 1 to 30 minutes.";
  return null;
}

/**
 * Whole seconds left in the dispatch window, never negative. Null when the
 * broadcast start isn't known yet.
 *
 * Honest about its limits: it reads the phone's clock against the server's
 * timestamp, and the server sweeps for timeouts every 30s, so the switch to
 * "no drivers" can land a little after this reaches 0. Callers should show 0
 * as "still searching", never as "failed".
 */
export function dispatchSecondsLeft(
  broadcastStartedAt: Date | string | null | undefined,
  nowMs: number,
  windowMs: number = DISPATCH_WINDOW_MS,
): number | null {
  if (!broadcastStartedAt) return null;
  const start = new Date(broadcastStartedAt).getTime();
  if (Number.isNaN(start)) return null;
  return Math.max(0, Math.ceil((start + windowMs - nowMs) / 1000));
}

/** Whole seconds since the search started, never negative; null when unknown. */
export function searchElapsedSeconds(broadcastStartedAt: Date | string | null | undefined, nowMs: number): number | null {
  if (!broadcastStartedAt) return null;
  const start = new Date(broadcastStartedAt).getTime();
  if (Number.isNaN(start)) return null;
  return Math.max(0, Math.floor((nowMs - start) / 1000));
}

/** "0:42", "3:05", "12:00": a stopwatch for the searching screen. */
export function stopwatch(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

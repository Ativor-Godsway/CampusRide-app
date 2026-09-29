/**
 * How long a ride is offered to drivers before the rider is asked what to do
 * (REQUESTED -> AWAITING_RIDER_DECISION). The server enforces it
 * (services/ride/timeouts.ts); the rider app shows the countdown from it.
 */
export const DISPATCH_WINDOW_MS = 90_000;

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
): number | null {
  if (!broadcastStartedAt) return null;
  const start = new Date(broadcastStartedAt).getTime();
  if (Number.isNaN(start)) return null;
  return Math.max(0, Math.ceil((start + DISPATCH_WINDOW_MS - nowMs) / 1000));
}

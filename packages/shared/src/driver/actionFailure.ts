/**
 * What a driver action does when its request fails.
 *
 * Driver actions (accept, I'm here, picked up, drop-off, cancel, add rider)
 * show their result the moment they are tapped. The request then goes in the
 * background, and a failure is one of two things:
 *
 * - "retry": nothing reached the server or the server hiccuped — no answer
 *   (timeout, offline), a 5xx, or 429 (slow down). The action is retried
 *   quietly; the server treats a repeat as a no-op, so retrying an action
 *   that actually landed is harmless.
 * - "refused": the server answered no (any other 4xx) — the ride was
 *   cancelled, another driver got there first. The screen goes back to the
 *   truth and says why, in the server's words.
 */
export type ActionFailureKind = "retry" | "refused";

export function classifyActionFailure(status: number | null | undefined): ActionFailureKind {
  if (status === undefined || status === null || status === 0) return "retry";
  if (status >= 500 || status === 429 || status === 408) return "retry";
  return "refused";
}

/** Pauses between quiet retries (ms). After the last one the action is reported as not sent. */
export const ACTION_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

/**
 * The message for a refusal: the server's own reason when it gave one,
 * otherwise a plain fallback. Never "reverted".
 */
export function refusalMessage(serverError: string | null | undefined, fallback: string): string {
  const text = serverError?.trim();
  return text ? text : fallback;
}

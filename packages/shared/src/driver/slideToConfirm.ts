/**
 * The decisions behind the driver's "slide to confirm" control ("Ama picked
 * up", "Cash collected"), kept pure so they're tested once:
 *
 * - the knob follows the finger along the track, clamped to it;
 * - a light haptic when it first reaches the end zone during a drag;
 * - released in the end zone: confirm; released anywhere before it: snap back;
 * - holding the knob still for LONG_PRESS_CONFIRM_MS also confirms (a
 *   fallback if dragging fails, and easier for some hands).
 */

/** Share of the track the knob must reach to count. */
export const SLIDE_COMPLETE_AT = 0.85;
/** Holding the knob this long confirms too. */
export const LONG_PRESS_CONFIRM_MS = 1_000;

/** Where the knob is (0 = start, 1 = end) for a drag of `dx` points along `travel` points of track. */
export function slideProgress(dx: number, travel: number): number {
  if (!(travel > 0) || !Number.isFinite(dx)) return 0;
  return Math.min(1, Math.max(0, dx / travel));
}

/** True on the update where the knob first enters the end zone (fire the light haptic). */
export function enteredEndZone(previous: number, next: number): boolean {
  return previous < SLIDE_COMPLETE_AT && next >= SLIDE_COMPLETE_AT;
}

/** What letting go does. */
export function slideRelease(progress: number): "confirm" | "snapBack" {
  return progress >= SLIDE_COMPLETE_AT ? "confirm" : "snapBack";
}

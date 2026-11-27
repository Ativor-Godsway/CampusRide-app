/**
 * Faster updates (2026-11-27): on a FRESH launch both apps ask EAS Update
 * for a newer JavaScript bundle. If there is one it downloads behind a short
 * "Updating…" screen and the app reloads into it — but never longer than
 * LAUNCH_UPDATE_MAX_MS (slow or offline: carry on with this version), and
 * never in the middle of a request or a trip (then it is only downloaded,
 * and expo-updates applies it on the next launch). No native change: the
 * same expo-updates the apps already ship.
 */

/** The longest the launch waits for an update (check and download together). */
export const LAUNCH_UPDATE_MAX_MS = 8_000;

export type LaunchUpdateStep =
  /** Nothing to do: updates off (development, Expo Go), or no newer bundle. */
  | "none"
  /** Download it now and reload into it, behind "Updating…". */
  | "apply-now"
  /** A ride is going on: download quietly; it is used from the next launch. */
  | "next-launch";

export function launchUpdateStep(input: { updatesEnabled: boolean; available: boolean; rideActive: boolean }): LaunchUpdateStep {
  if (!input.updatesEnabled || !input.available) return "none";
  return input.rideActive ? "next-launch" : "apply-now";
}

/** Whether there's still time to reload into a downloaded update. */
export function withinLaunchBudget(startedAt: number, now: number): boolean {
  return now - startedAt < LAUNCH_UPDATE_MAX_MS;
}

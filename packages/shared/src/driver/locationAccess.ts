/**
 * Location for the driver app while online (Google Play's background
 * location and foreground service rules, Apple review). The wording shown to
 * drivers and the decision of what to do when they go online live here, as
 * plain data and functions, so they are tested in one place.
 */

/**
 * The prominent disclosure, shown full screen BEFORE any system location
 * prompt. Google requires it to say what is collected, what for, and the
 * words "even when the app is closed or not in use".
 */
export const DRIVER_LOCATION_DISCLOSURE = {
  title: "Share your location while you're online",
  body: "CampusRide Driver collects location data to share your position with riders and match you with nearby ride requests while you are online, even when the app is closed or not in use.",
  details: [
    "Riders on your trip see where you are, so they know when you'll arrive.",
    "Ride requests near you reach you first.",
    "Location sharing stops as soon as you go offline.",
    "On the next screen, choose “Allow all the time” (Android) or “Always” (iPhone) so riders still see you when you switch to another app.",
  ],
  accept: "Continue",
  decline: "Not now",
} as const;

/** The notification shown the whole time a driver is online (Android foreground service). */
export const DRIVER_ONLINE_NOTIFICATION = {
  title: "You're online",
  body: "CampusRide Driver is sharing your location.",
} as const;

export type PermissionState = "granted" | "denied" | "undetermined";

export interface LocationPermissions {
  foreground: PermissionState;
  /** Whether the system will still show the foreground prompt. */
  foregroundCanAsk: boolean;
  background: PermissionState;
  backgroundCanAsk: boolean;
}

/**
 * What going online needs, given the current permissions:
 * - `always`: allowed in the background too; go online.
 * - `whileUsing`: allowed only while the app is open, and the driver already
 *   said no to "all the time": go online without asking again (no nagging).
 * - `disclose`: show the disclosure, then the system prompt(s).
 * - `settings`: location was refused for good; only Settings can change it.
 */
export type LocationAccessPlan = "always" | "whileUsing" | "disclose" | "settings";

export function planLocationAccess(p: LocationPermissions): LocationAccessPlan {
  if (p.foreground === "granted") {
    if (p.background === "granted") return "always";
    if (p.background === "undetermined" && p.backgroundCanAsk) return "disclose";
    return "whileUsing";
  }
  return p.foregroundCanAsk ? "disclose" : "settings";
}

export const LOCATION_SETTINGS_MESSAGE =
  "CampusRide Driver needs your location to go online. Allow it in Settings, then try again.";

export const WHILE_USING_ONLY_MESSAGE =
  "You're online. While CampusRide Driver is in the background, riders won't see you move. To keep sharing your location, allow location “All the time” in Settings.";

/**
 * What the driver's answer to the "all the time" prompt means for going
 * online. Saying no still goes online on "while using", and the go-online
 * flow shows WHILE_USING_ONLY_MESSAGE first.
 */
export function accessFromAlwaysAnswer(status: PermissionState | string): "always" | "whileUsing" {
  return status === "granted" ? "always" : "whileUsing";
}

/**
 * Expo Go on iPhone has no "Always" location usage description, so asking
 * for "all the time" there is rejected with ERR_LOCATION_INFO_PLIST (the
 * store builds have it: apps/driver/app.json, expo-location plugin). True
 * only for that error AND in Expo Go: the one failure the driver app treats
 * as a "while using" answer. Anything else is passed on.
 */
export function isExpoGoMissingAlwaysKey(error: unknown, inExpoGo: boolean): boolean {
  const code =
    typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return inExpoGo && code === "ERR_LOCATION_INFO_PLIST";
}

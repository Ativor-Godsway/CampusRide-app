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
  /** Short lines (the screen gives each an icon). The last one matches the privacy policy (90 days). */
  details: [
    "Riders on your trip see where you are.",
    "Ride requests near you reach you first.",
    "Sharing stops as soon as you go offline.",
    "We keep your location history for up to 90 days for safety and service quality.",
  ],
  /** Under the lines: what to choose on the system prompt that follows. */
  hint: "On the next screen, choose “Allow all the time” (Android) or “Always” (iPhone) so riders still see you when you switch to another app.",
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

/**
 * Why going online stopped before the server was asked, shown on Home with
 * an "Open Settings" button:
 * - `refused`: location isn't allowed (refused, or "Not now" with nothing allowed);
 * - `failed`: asking the phone for location failed outright (a store build
 *   whose "Always" request threw, location services off, …).
 */
export type LocationProblem = "refused" | "failed";

export const LOCATION_PROBLEM_MESSAGE: Record<LocationProblem, string> = {
  refused: LOCATION_SETTINGS_MESSAGE,
  failed:
    "We couldn't turn on location for CampusRide Driver. Allow location “Always” in Settings, then go online again.",
};

/** What going online may do, once the location steps are done. */
export type GoOnlineAccess =
  /** Go online; `explainWhileUsing`: the driver just declined "all the time", say what that means once. */
  | { kind: "go"; access: "always" | "whileUsing"; explainWhileUsing: boolean }
  /** Stay offline: the server is never asked, so the app and the server agree. */
  | { kind: "stop"; problem: LocationProblem; error?: unknown };

/**
 * The location part of going online, in order: what's allowed now; if
 * needed, the disclosure and then the system prompts. Any step that throws
 * (e.g. the "Always" request in a store build, for any reason but Expo Go's
 * missing key, which requestAccess answers as "whileUsing" itself) means
 * staying offline with `failed` — never online on a guess.
 */
export async function resolveGoOnlineAccess(steps: {
  currentPlan: () => Promise<LocationAccessPlan>;
  /** The disclosure: true for Continue, false for Not now. */
  askDisclosure: () => Promise<boolean>;
  /** The system prompts, after Continue. */
  requestAccess: () => Promise<"always" | "whileUsing" | "none">;
}): Promise<GoOnlineAccess> {
  try {
    const plan = await steps.currentPlan();
    if (plan === "always" || plan === "whileUsing") {
      return { kind: "go", access: plan, explainWhileUsing: false };
    }
    if (plan === "settings") return { kind: "stop", problem: "refused" };

    if (await steps.askDisclosure()) {
      const access = await steps.requestAccess();
      if (access === "none") return { kind: "stop", problem: "refused" };
      return { kind: "go", access, explainWhileUsing: access === "whileUsing" };
    }
    // "Not now": online anyway if "while using" was already allowed.
    return (await steps.currentPlan()) === "whileUsing"
      ? { kind: "go", access: "whileUsing", explainWhileUsing: false }
      : { kind: "stop", problem: "refused" };
  } catch (error) {
    return { kind: "stop", problem: "failed", error };
  }
}

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

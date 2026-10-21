/**
 * The forced "Time to update" screen (docs/runbooks/releasing.md, "Forcing an
 * update"). The server's public GET /app/min-version says, per app and
 * platform, the lowest store version still allowed and where to get a newer
 * one; the apps compare it with their own native version on launch and on
 * every return to the foreground. Pure, so the rules are tested here; the
 * apps use them through @rida/mobile-shared's AppUpdateGate.
 *
 * Every doubt lets the person in: an unset or malformed minimum, a version
 * the phone can't read, a failed or slow check. Only a clear "your version
 * is below the minimum" ever blocks.
 */

export type AppKind = "rider" | "driver";
export type AppPlatform = "ios" | "android";

export interface PlatformRequirement {
  /** Lowest allowed native version ("1.2.0"), or null: nobody is blocked. */
  minVersion: string | null;
  /** Where "Update now" goes, or null: the screen says to search the store instead. */
  storeUrl: string | null;
}

export type AppMinVersions = Record<AppKind, Record<AppPlatform, PlatformRequirement>>;

export const APP_MIN_VERSION_PATH = "/app/min-version";

/** A check that hasn't answered by then has failed, and the person gets in. */
export const UPDATE_CHECK_TIMEOUT_MS = 5_000;

/** Where each app is on Google Play; the App Store links come once the listings exist. */
export const DEFAULT_STORE_URLS: Record<AppKind, Record<AppPlatform, string | null>> = {
  rider: { ios: null, android: "https://play.google.com/store/apps/details?id=com.campusride.rider" },
  driver: { ios: null, android: "https://play.google.com/store/apps/details?id=com.campusride.driver" },
};

/**
 * "1.2.3" -> [1, 2, 3]. "1" and "1.2" count as "1.0.0" and "1.2.0" (a store
 * version can be written short); anything else, a "-beta" suffix included,
 * is not a version (null).
 */
export function parseVersion(raw: string | null | undefined): [number, number, number] | null {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec((raw ?? "").trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

/** -1, 0 or 1, like a sort comparator; null when either one isn't a version. */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

/** Only an https link is opened; anything else counts as no link. */
export function normalizeStoreUrl(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  return /^https:\/\/\S+$/i.test(value) ? value : null;
}

export interface UpdateRequirement {
  /** The installed version is below the minimum. */
  required: boolean;
  storeUrl: string | null;
}

export const NO_UPDATE_REQUIRED: UpdateRequirement = { required: false, storeUrl: null };

/**
 * What the server's answer means for this app on this phone. The answer
 * comes off the network, so it is read defensively: a missing or odd field
 * is "not required".
 */
export function updateRequirement(
  answer: unknown,
  app: AppKind,
  platform: string,
  installedVersion: string | null | undefined,
): UpdateRequirement {
  if (platform !== "ios" && platform !== "android") return NO_UPDATE_REQUIRED;
  const entry = (answer as Partial<AppMinVersions> | null | undefined)?.[app]?.[platform];
  if (!entry || typeof entry !== "object") return NO_UPDATE_REQUIRED;
  const minVersion = typeof entry.minVersion === "string" ? entry.minVersion : null;
  const storeUrl = normalizeStoreUrl(typeof entry.storeUrl === "string" ? entry.storeUrl : null);
  const order = compareVersions(installedVersion, minVersion);
  return { required: order === -1, storeUrl };
}

/**
 * The answer kept after a check. A failed check (offline, server down, too
 * slow) changes nothing: at launch that means the person gets in; once the
 * screen is up, switching to airplane mode doesn't take it down.
 */
export function nextUpdateRequirement(
  previous: UpdateRequirement,
  check: { ok: true; requirement: UpdateRequirement } | { ok: false },
): UpdateRequirement {
  return check.ok ? check.requirement : previous;
}

/**
 * Whether a trip is going on, for the update screen: "unknown" while a
 * signed-in person's trip hasn't loaded (it might be one), "none" signed out.
 */
export type TripState = "none" | "active" | "unknown";

/**
 * A due update screen waits while a trip is going on, or might be, or while
 * its screen is still open (the trip summary, the rating): it shows the moment
 * that ends. A driver mid-trip, or a rider searching, waiting for a driver or
 * in the car, is never interrupted.
 */
export function holdUpdateScreen(input: { trip: TripState; onTripScreen: boolean }): boolean {
  return input.trip !== "none" || input.onTripScreen;
}

export function showUpdateScreen(requirement: UpdateRequirement, hold: boolean): boolean {
  return requirement.required && !hold;
}

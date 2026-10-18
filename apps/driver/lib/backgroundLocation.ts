import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import {
  DRIVER_ONLINE_NOTIFICATION,
  planLocationAccess,
  type ArrivalSample,
  type LocationAccessPlan,
  type PermissionState,
} from "@rida/shared";

/**
 * Location while a driver is online, including when the app is in the
 * background (the driver switches to maps, or the screen goes off): riders
 * keep seeing the car move and the driver's zone stays current.
 *
 * - Android: a foreground service with a notification the whole time
 *   ("You're online. CampusRide Driver is sharing your location."), stopped
 *   when the driver goes offline, signs out, or swipes the app away.
 * - iOS: background location with the blue location indicator showing.
 *
 * Positions arrive in the task below and are handed to DriverLocationProvider
 * (lib/location.tsx), which every screen already reads. Without "all the
 * time" permission the provider falls back to tracking only while the app is
 * open.
 */
export const DRIVER_LOCATION_TASK = "campusride-driver-location";

type Listener = (sample: ArrivalSample) => void;
const listeners = new Set<Listener>();

/** Receives every background position; returns the unsubscribe. */
export function onDriverLocation(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Defined when this module loads (imported by app/_layout.tsx), as the OS can
// deliver positions as soon as the app starts.
TaskManager.defineTask(DRIVER_LOCATION_TASK, async ({ data, error }) => {
  if (error || !data) return;
  const locations = (data as { locations?: Location.LocationObject[] }).locations ?? [];
  const latest = locations[locations.length - 1];
  if (!latest) return;
  const sample: ArrivalSample = {
    latitude: latest.coords.latitude,
    longitude: latest.coords.longitude,
    speed: latest.coords.speed,
    at: latest.timestamp || Date.now(),
  };
  for (const listener of listeners) listener(sample);
});

const state = (status: string): PermissionState =>
  status === "granted" ? "granted" : status === "denied" ? "denied" : "undetermined";

/** What going online needs right now (see planLocationAccess). */
export async function currentLocationAccessPlan(): Promise<LocationAccessPlan> {
  const [fg, bg] = await Promise.all([
    Location.getForegroundPermissionsAsync(),
    Location.getBackgroundPermissionsAsync(),
  ]);
  return planLocationAccess({
    foreground: state(fg.status),
    foregroundCanAsk: fg.canAskAgain,
    background: state(bg.status),
    backgroundCanAsk: bg.canAskAgain,
  });
}

/**
 * The system prompts, in order, after the driver tapped Continue on the
 * disclosure: "while using the app" first, then "all the time" (on Android
 * 11+ that opens the app's location settings page). Returns what was allowed.
 */
export async function requestDriverLocationAccess(): Promise<"always" | "whileUsing" | "none"> {
  let fg = await Location.getForegroundPermissionsAsync();
  if (fg.status !== "granted") fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== "granted") return "none";
  try {
    const bg = await Location.requestBackgroundPermissionsAsync();
    return bg.status === "granted" ? "always" : "whileUsing";
  } catch {
    // ERR_LOCATION_INFO_PLIST: the running app has no "Always" usage
    // description. Our store builds do (app.json, expo-location plugin);
    // Expo Go on iPhone doesn't. Go online on "while using" instead of failing.
    return "whileUsing";
  }
}

export async function hasBackgroundLocationAccess(): Promise<boolean> {
  const [fg, bg] = await Promise.all([
    Location.getForegroundPermissionsAsync(),
    Location.getBackgroundPermissionsAsync(),
  ]);
  return fg.status === "granted" && bg.status === "granted";
}

/** Starts background updates (and Android's online notification). Safe to call twice. */
export async function startDriverLocationUpdates(): Promise<void> {
  if (await Location.hasStartedLocationUpdatesAsync(DRIVER_LOCATION_TASK)) return;
  await Location.startLocationUpdatesAsync(DRIVER_LOCATION_TASK, {
    accuracy: Location.Accuracy.Balanced,
    timeInterval: 5_000,
    distanceInterval: 10,
    // iOS: the blue indicator, so the driver can always see location is on;
    // never paused by the OS while they're online.
    showsBackgroundLocationIndicator: true,
    pausesUpdatesAutomatically: false,
    activityType: Location.ActivityType.AutomotiveNavigation,
    foregroundService: {
      notificationTitle: DRIVER_ONLINE_NOTIFICATION.title,
      notificationBody: DRIVER_ONLINE_NOTIFICATION.body,
      notificationColor: "#19743C",
      // Swiping the app away stops location too.
      killServiceOnDestroy: true,
    },
  });
}

/** Stops background updates and the notification. Safe to call when not running. */
export async function stopDriverLocationUpdates(): Promise<void> {
  const running = await Location.hasStartedLocationUpdatesAsync(DRIVER_LOCATION_TASK).catch(
    () => false,
  );
  if (running) await Location.stopLocationUpdatesAsync(DRIVER_LOCATION_TASK);
}

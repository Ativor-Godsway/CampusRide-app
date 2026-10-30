import Constants, { ExecutionEnvironment } from "expo-constants";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import {
  DRIVER_ONLINE_NOTIFICATION,
  accessFromAlwaysAnswer,
  isExpoGoMissingAlwaysKey,
  planLocationAccess,
  type ArrivalSample,
  type LocationAccessPlan,
  type PermissionState,
} from "@rida/shared";
// Sentry directly, not @rida/mobile-shared: this module loads first, from
// the entry (index.ts), and must stay light. A no-op until Sentry starts.
import * as Sentry from "@sentry/react-native";

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

// Defined when this module loads: first thing, from the app's entry (index.ts),
// as the OS can deliver positions as soon as the app starts, even in the
// background with no screen loaded.
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
  let bg: Location.LocationPermissionResponse;
  try {
    bg = await Location.requestBackgroundPermissionsAsync();
  } catch (error) {
    // Expo Go on iPhone can't ask for "all the time" (see isExpoGoMissingAlwaysKey).
    const inExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;
    if (isExpoGoMissingAlwaysKey(error, inExpoGo)) return "whileUsing";
    throw error;
  }
  return accessFromAlwaysAnswer(bg.status);
}

export async function hasBackgroundLocationAccess(): Promise<boolean> {
  const [fg, bg] = await Promise.all([
    Location.getForegroundPermissionsAsync(),
    Location.getBackgroundPermissionsAsync(),
  ]);
  return fg.status === "granted" && bg.status === "granted";
}

/**
 * Starts and stops run one after another: going offline while going online
 * (or a permission re-check restarting updates) used to overlap a stop with a
 * start, and the stop was rejected ("Call to function
 * 'ExpoLocation.stopLocationUpdatesAsync' has been rejected").
 */
let queue: Promise<unknown> = Promise.resolve();
function serially<T>(step: () => Promise<T>): Promise<T> {
  const run = queue.then(step, step);
  queue = run.catch(() => undefined);
  return run;
}

/**
 * Starts background updates (and Android's online notification). Safe to
 * call twice. False when they can't run because the task isn't defined: the
 * caller tracks while the app is open instead, and Sentry hears about it.
 */
export function startDriverLocationUpdates(): Promise<boolean> {
  return serially(startNow);
}

/** Reported once per launch: a sign the entry (index.ts) didn't load this module first. */
let reportedUndefinedTask = false;

async function startNow(): Promise<boolean> {
  // index.ts defines the task before anything else loads, so this can only
  // fail if the entry changes. Starting anyway would register a task whose
  // positions go nowhere.
  if (!TaskManager.isTaskDefined(DRIVER_LOCATION_TASK)) {
    if (!reportedUndefinedTask) {
      reportedUndefinedTask = true;
      Sentry.captureException(
        new Error(`Background location task '${DRIVER_LOCATION_TASK}' is not defined; tracking only while open`),
        { tags: { caught_by: "driver_location_start" } },
      );
    }
    return false;
  }
  if (await Location.hasStartedLocationUpdatesAsync(DRIVER_LOCATION_TASK)) return true;
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
  return true;
}

/**
 * Stops background updates and the notification. Safe to call when not
 * running: only stops what is registered and started, and a stop the OS
 * beat us to (the service already gone) is not an error.
 *
 * On iOS "Task 'campusride-driver-location' not found" (Sentry
 * CAMPUSRIDE-DRIVER-1, build 1.0.0 (3)) comes from here, not from starting:
 * two stops overlapped (going online re-ran the location effect), both saw
 * updates running, and the second one found the task already removed.
 * Running one step at a time and the try/catch below are the fix.
 */
export function stopDriverLocationUpdates(): Promise<void> {
  return serially(async () => {
    const [registered, running] = await Promise.all([
      TaskManager.isTaskRegisteredAsync(DRIVER_LOCATION_TASK).catch(() => false),
      Location.hasStartedLocationUpdatesAsync(DRIVER_LOCATION_TASK).catch(() => false),
    ]);
    if (!registered || !running) return;
    try {
      await Location.stopLocationUpdatesAsync(DRIVER_LOCATION_TASK);
    } catch {
      // Already stopped between the check and the call: nothing left to stop.
    }
  });
}

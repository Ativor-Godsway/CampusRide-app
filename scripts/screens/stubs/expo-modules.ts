/**
 * Stand-ins for the native expo modules (and Sentry, socket.io): each
 * namespace below becomes one module (build.mjs, STAND_INS). They answer the
 * way a phone with every permission granted would, at the scene's position.
 */

const resolved = async <T>(value: T) => value;
const noop = () => undefined;
const subscription = () => ({ remove: noop });
const granted = { status: "granted", granted: true, canAskAgain: true, expires: "never" };

export const device = { isDevice: false, osName: "iOS", modelName: "iPhone", brand: "Apple" };

/**
 * What the phone says about notifications. The harness sets "undetermined"
 * (and isDevice) for a scene of the explanation screen before anyone's asked.
 */
export const scenePush = { status: "granted" as "granted" | "undetermined" | "denied" };
const pushPermission = () => ({
  ...granted,
  status: scenePush.status,
  granted: scenePush.status === "granted",
});

/**
 * Whether the scene's rider allowed location, and the driver's "all the
 * time" answer: granted, not asked yet, or the request failing outright
 * (the harness sets them).
 */
export const sceneLocation = {
  allowed: true,
  background: "granted" as "granted" | "undetermined" | "fails",
};
const refused = { status: "denied", granted: false, canAskAgain: false, expires: "never" };
const foregroundPermission = () => (sceneLocation.allowed ? granted : refused);

/** Where the phone is: the harness sets it per scene. */
export const scenePosition = { latitude: 5.6505, longitude: -0.1866 };

export const font = {
  useFonts: () => [true, null] as const,
  isLoaded: () => true,
  loadAsync: () => resolved(undefined),
};

export const haptics = {
  selectionAsync: () => resolved(undefined),
  impactAsync: () => resolved(undefined),
  notificationAsync: () => resolved(undefined),
  ImpactFeedbackStyle: { Light: "light", Medium: "medium", Heavy: "heavy" },
  NotificationFeedbackType: { Success: "success", Warning: "warning", Error: "error" },
};

/** The keychain: the harness puts a refresh token here for signed-in scenes. */
export const secureStoreData = new Map<string, string>();
export const secureStore = {
  AFTER_FIRST_UNLOCK: 0,
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 1,
  getItemAsync: async (key: string) => secureStoreData.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => void secureStoreData.set(key, value),
  deleteItemAsync: async (key: string) => void secureStoreData.delete(key),
};

export const constants = {
  executionEnvironment: "standalone",
  appOwnership: null,
  expoConfig: {
    name: "CampusRide",
    slug: "campusride",
    version: "1.0.0",
    extra: { SERVER_URL: "https://screens.invalid" },
  },
  ExecutionEnvironment: { Bare: "bare", Standalone: "standalone", StoreClient: "storeClient" },
};

export const application = {
  nativeApplicationVersion: "1.0.0",
  nativeBuildVersion: "1",
  applicationName: "CampusRide",
};

export const updates = {
  channel: null,
  isEmbeddedLaunch: true,
  runtimeVersion: "screens",
  updateId: null,
};

export const notifications = {
  AndroidImportance: { HIGH: 4, DEFAULT: 3 },
  AndroidNotificationVisibility: { PUBLIC: 1 },
  DEFAULT: "default",
  addPushTokenListener: subscription,
  addNotificationReceivedListener: subscription,
  addNotificationResponseReceivedListener: subscription,
  clearLastNotificationResponseAsync: () => resolved(undefined),
  getExpoPushTokenAsync: () => resolved({ data: "ExponentPushToken[screens]" }),
  getPermissionsAsync: () => resolved(pushPermission()),
  requestPermissionsAsync: () => resolved(pushPermission()),
  setNotificationChannelAsync: () => resolved(null),
  setNotificationHandler: noop,
  useLastNotificationResponse: () => null,
};

const fix = () => ({
  coords: { ...scenePosition, altitude: 0, accuracy: 5, altitudeAccuracy: 5, heading: 0, speed: 0 },
  timestamp: Date.now(),
});

export const location = {
  Accuracy: { Lowest: 1, Low: 2, Balanced: 3, High: 4, Highest: 5, BestForNavigation: 6 },
  ActivityType: { Other: 1, AutomotiveNavigation: 2, Fitness: 3, OtherNavigation: 4 },
  getForegroundPermissionsAsync: () => resolved(foregroundPermission()),
  requestForegroundPermissionsAsync: () => resolved(foregroundPermission()),
  getBackgroundPermissionsAsync: () =>
    resolved(
      sceneLocation.background === "granted"
        ? granted
        : { status: "undetermined", granted: false, canAskAgain: true, expires: "never" },
    ),
  requestBackgroundPermissionsAsync: async () => {
    if (sceneLocation.background === "fails") {
      throw Object.assign(new Error("Location request failed"), { code: "E_LOCATION_UNAVAILABLE" });
    }
    return granted;
  },
  hasServicesEnabledAsync: () => resolved(true),
  getLastKnownPositionAsync: () => resolved(fix()),
  getCurrentPositionAsync: () => resolved(fix()),
  watchPositionAsync: async (_options: unknown, callback: (p: ReturnType<typeof fix>) => void) => {
    setTimeout(() => callback(fix()), 0);
    return { remove: noop };
  },
  hasStartedLocationUpdatesAsync: () => resolved(false),
  startLocationUpdatesAsync: () => resolved(undefined),
  stopLocationUpdatesAsync: () => resolved(undefined),
};

export const taskManager = { defineTask: noop, isTaskRegisteredAsync: () => resolved(false) };

export const keepAwake = {
  activateKeepAwakeAsync: () => resolved(undefined),
  deactivateKeepAwake: () => resolved(undefined),
  useKeepAwake: noop,
};

export const audio = {
  createAudioPlayer: () => ({
    play: noop,
    pause: noop,
    seekTo: () => resolved(undefined),
    remove: noop,
    volume: 1,
  }),
  setAudioModeAsync: () => resolved(undefined),
};

export const imagePicker = {
  CameraType: { front: "front", back: "back" },
  MediaTypeOptions: { Images: "Images" },
  launchCameraAsync: () => resolved({ canceled: true, assets: null }),
  launchImageLibraryAsync: () => resolved({ canceled: true, assets: null }),
  requestCameraPermissionsAsync: () => resolved(granted),
  requestMediaLibraryPermissionsAsync: () => resolved(granted),
};

export const fileSystem = {
  File: class {},
  Paths: {},
  documentDirectory: "/",
  cacheDirectory: "/",
};

export const webBrowser = { openBrowserAsync: () => resolved({ type: "cancel" }) };

export const linking = {
  addEventListener: subscription,
  getInitialURL: () => resolved(null),
  useURL: () => null,
  createURL: (p: string) => `campusride://${p}`,
  openSettings: () => resolved(undefined),
  openURL: () => resolved(true),
  canOpenURL: () => resolved(true),
  parse: (url: string) => ({ path: url, queryParams: {} }),
};

export const statusBar = { StatusBar: () => null, setStatusBarStyle: noop };

export const splashScreen = {
  setOptions: noop,
  preventAutoHideAsync: () => resolved(true),
  hide: noop,
  hideAsync: () => resolved(undefined),
};

export const sentry = {
  init: noop,
  setTags: noop,
  setTag: noop,
  setUser: noop,
  captureException: noop,
  addBreadcrumb: noop,
  wrap: <T>(component: T) => component,
};

/** One event per name the scene's socket "receives" (the harness sets it), e.g. a driver's position. */
export const sceneSocketEvents: Record<string, unknown> = {};

/**
 * A socket that never connects: live updates don't exist in a screenshot,
 * except a scene's sceneSocketEvents, each sent once to whoever listens.
 */
export const socket = {
  io: () => ({
    connected: false,
    active: false,
    on: (event: string, handler: (payload: unknown) => void) => {
      if (event in sceneSocketEvents) setTimeout(() => handler(sceneSocketEvents[event]), 100);
    },
    off: noop,
    once: noop,
    emit: noop,
    connect: noop,
    disconnect: noop,
    removeAllListeners: noop,
    io: { on: noop, off: noop, opts: {} },
    auth: {},
  }),
};

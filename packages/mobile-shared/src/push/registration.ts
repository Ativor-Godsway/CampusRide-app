import { Platform } from "react-native";
import Constants, { ExecutionEnvironment } from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { ANDROID_CHANNELS, type PushApp } from "@rida/shared";
import { api } from "../auth/apiClient";
import { getSentPushToken, setCurrentPushToken, setSentPushToken } from "./currentToken";

/**
 * Push notification set-up for the rider and driver apps (server side:
 * apps/server/src/services/push). Nothing here asks for permission on its
 * own: the explanation screen (NotificationPermissionScreen) is the only
 * place that does, after login.
 *
 * Push can't work in Expo Go (no native push set-up) or on a simulator, so
 * every function here quietly does nothing there.
 */
export function pushSupported(): boolean {
  return Device.isDevice && Constants.executionEnvironment !== ExecutionEnvironment.StoreClient;
}

/**
 * The app's one Android channel. Created right before permission is asked
 * (never at first launch) and on each signed-in launch after that.
 * Android fixes a channel's importance and sound the first time it is
 * created on a phone; changing them later means a new channel id.
 */
export async function ensureAndroidChannel(app: PushApp): Promise<void> {
  if (Platform.OS !== "android") return;
  const spec = ANDROID_CHANNELS[app];
  await Notifications.setNotificationChannelAsync(spec.id, {
    name: spec.name,
    description: spec.description,
    importance: Notifications.AndroidImportance.HIGH,
    sound: "default",
    vibrationPattern: [0, 250, 250, 250],
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
  });
}

export type PushPermission = "granted" | "denied" | "undetermined" | "unsupported";

export async function getPushPermission(): Promise<PushPermission> {
  if (!pushSupported()) return "unsupported";
  const { status } = await Notifications.getPermissionsAsync();
  return status === "granted" ? "granted" : status === "denied" ? "denied" : "undetermined";
}

const ASKED_KEY = "rida.pushPermissionAsked";

/** Whether this install has already shown its explanation screen. */
export async function hasAskedForPush(): Promise<boolean> {
  return (await SecureStore.getItemAsync(ASKED_KEY)) === "1";
}

export async function markAskedForPush(): Promise<void> {
  await SecureStore.setItemAsync(ASKED_KEY, "1");
}

/**
 * Sends to the server (PUT /me/push-token) are never closer together than
 * this, and twice as far apart after each failure, up to the cap — so no
 * bug can send more than a few a minute. A send held back by it is tried
 * once when it is allowed.
 */
export const PUSH_SEND_MIN_INTERVAL_MS = 20_000;
const PUSH_SEND_MAX_INTERVAL_MS = 15 * 60_000;
/**
 * An unchanged token is sent again after this long anyway: the server keeps
 * each person's most recently sent installs, and drops tokens Expo reports
 * dead (which a phone whose notifications were turned back on still uses).
 */
export const PUSH_RESEND_AFTER_MS = 7 * 24 * 60 * 60_000;

export interface RegisterForPushOptions {
  /**
   * The phone's token, as the token listener received it: used as is, never
   * fetched again. Fetching it is what makes the listener fire (iOS and
   * Android both report every fetch, changed or not).
   */
  devicePushToken?: Notifications.DevicePushToken;
  /** Send even if this token was already sent for this person (they just turned notifications on). */
  force?: boolean;
}

interface Registration extends RegisterForPushOptions {
  app: PushApp;
  userId: string;
}

let running: Promise<void> | null = null;
/** Asked for while one was running: runs once after it. */
let followUp: Registration | null = null;
let heldBack: ReturnType<typeof setTimeout> | null = null;
/** Bumped by stopPushRegistration: a registration from before it never sends. */
let generation = 0;
/** The phone token the last registration used. The listener repeats it after every fetch. */
let lastDeviceToken: Notifications.DevicePushToken | null = null;
let lastFetchAt = Number.NEGATIVE_INFINITY;
let lastSendAt = Number.NEGATIVE_INFINITY;
let failedSends = 0;

function deviceTokenKey(token: Notifications.DevicePushToken): string {
  return typeof token.data === "string" ? token.data : JSON.stringify(token.data);
}

function nextSendAllowedAt(): number {
  const interval = Math.min(PUSH_SEND_MAX_INTERVAL_MS, PUSH_SEND_MIN_INTERVAL_MS * 2 ** failedSends);
  return lastSendAt + interval;
}

/**
 * Sends this install's push token to the server for the signed-in user, if
 * notifications are allowed and the server doesn't have it already. Safe to
 * call on every launch and from the token listener. One at a time; a call
 * made while one runs is folded into a single follow-up. Never throws.
 */
export function registerForPush(
  app: PushApp,
  userId: string,
  options: RegisterForPushOptions = {},
): Promise<void> {
  if (running) {
    followUp = {
      app,
      userId,
      devicePushToken: options.devicePushToken ?? followUp?.devicePushToken,
      force: Boolean(options.force || followUp?.force),
    };
    return running;
  }
  const current = registerOnce({ app, userId, ...options }).finally(() => {
    running = null;
    const next = followUp;
    followUp = null;
    if (next) void registerForPush(next.app, next.userId, next);
  });
  running = current;
  return current;
}

/**
 * Signed out (or the root layout went away): nothing still queued, held back
 * or half-way through sends a token for the person who left.
 */
export function stopPushRegistration(): void {
  generation += 1;
  followUp = null;
  if (heldBack) clearTimeout(heldBack);
  heldBack = null;
}

async function registerOnce({ app, userId, devicePushToken, force = false }: Registration): Promise<void> {
  const mine = generation;
  try {
    // The listener reporting the token this install just fetched: nothing new.
    if (
      devicePushToken &&
      !force &&
      lastDeviceToken &&
      deviceTokenKey(devicePushToken) === deviceTokenKey(lastDeviceToken)
    )
      return;
    if ((await getPushPermission()) !== "granted") return;
    await ensureAndroidChannel(app);
    let device = devicePushToken;
    if (!device && lastDeviceToken && Date.now() - lastFetchAt < PUSH_SEND_MIN_INTERVAL_MS) {
      // Fetched moments ago: a fetch now would only make the listener fire again.
      device = lastDeviceToken;
    }
    if (!device) {
      lastFetchAt = Date.now();
      device = await Notifications.getDevicePushTokenAsync();
    }
    lastDeviceToken = device;
    const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
    const { data: token } = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId, devicePushToken: device } : { devicePushToken: device },
    );

    const now = Date.now();
    const sent = await getSentPushToken();
    if (
      !force &&
      sent?.userId === userId &&
      sent.token === token &&
      now - sent.sentAt < PUSH_RESEND_AFTER_MS
    ) {
      setCurrentPushToken(token);
      return;
    }
    if (mine !== generation) return;
    const wait = nextSendAllowedAt() - now;
    if (wait > 0) {
      // Fetched again when it's allowed, in case the token changes meanwhile.
      if (heldBack) clearTimeout(heldBack);
      heldBack = setTimeout(() => {
        heldBack = null;
        if (mine === generation) void registerForPush(app, userId, { force });
      }, wait);
      return;
    }
    lastSendAt = now;
    try {
      await sendTokenToServer(app, token);
    } catch (error) {
      failedSends += 1;
      throw error;
    }
    failedSends = 0;
    await setSentPushToken({ userId, token, sentAt: now });
  } catch {
    // No network, the push service unreachable, the server refusing: the
    // next launch, token change or visit to the permission screen tries again.
  }
}

/** Tests only: as a fresh launch. */
export function resetPushRegistrationForTests(): void {
  stopPushRegistration();
  running = null;
  lastDeviceToken = null;
  lastFetchAt = Number.NEGATIVE_INFINITY;
  lastSendAt = Number.NEGATIVE_INFINITY;
  failedSends = 0;
}

export async function sendTokenToServer(app: PushApp, token: string): Promise<void> {
  await api.put("/me/push-token", {
    token,
    app,
    platform: Platform.OS === "ios" ? "ios" : "android",
  });
  setCurrentPushToken(token);
}

/**
 * The explanation screen's "Turn on" button: asks the system for permission
 * and, if allowed, registers. Returns what the person chose.
 */
export async function requestPushPermission(
  app: PushApp,
  userId: string | null,
): Promise<PushPermission> {
  if (!pushSupported()) return "unsupported";
  await markAskedForPush();
  await ensureAndroidChannel(app);
  const { status } = await Notifications.requestPermissionsAsync();
  if (status !== "granted") return status === "denied" ? "denied" : "undetermined";
  if (userId) await registerForPush(app, userId, { force: true });
  return "granted";
}

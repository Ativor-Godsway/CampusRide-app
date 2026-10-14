import { Platform } from "react-native";
import Constants, { ExecutionEnvironment } from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { ANDROID_CHANNELS, type PushApp } from "@rida/shared";
import { api } from "../auth/apiClient";
import { setCurrentPushToken } from "./currentToken";

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
 * Sends this install's push token to the server for the signed-in user, if
 * notifications are allowed. Safe to call on every launch. Never throws.
 */
export async function registerForPush(app: PushApp): Promise<void> {
  try {
    if ((await getPushPermission()) !== "granted") return;
    await ensureAndroidChannel(app);
    const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
    const { data: token } = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined,
    );
    await sendTokenToServer(app, token);
  } catch {
    // No network, or the push service is unreachable: the next launch tries again.
  }
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
export async function requestPushPermission(app: PushApp): Promise<PushPermission> {
  if (!pushSupported()) return "unsupported";
  await markAskedForPush();
  await ensureAndroidChannel(app);
  const { status } = await Notifications.requestPermissionsAsync();
  if (status !== "granted") return status === "denied" ? "denied" : "undetermined";
  await registerForPush(app);
  return "granted";
}

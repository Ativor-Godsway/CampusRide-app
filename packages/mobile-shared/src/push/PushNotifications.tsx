import { useEffect, useRef } from "react";
import { usePathname, useSegments } from "expo-router";
import * as Notifications from "expo-notifications";
import { isAnnouncementPushData, parsePushData, type PushApp, type PushData } from "@rida/shared";
import { useAuth } from "../auth/AuthContext";
import {
  getPushPermission,
  hasAskedForPush,
  markAskedForPush,
  pushSupported,
  registerForPush,
  stopPushRegistration,
} from "./registration";

export interface PushNotificationsProps {
  app: PushApp;
  /**
   * Whether a notification that arrives while the app is open is shown as a
   * banner. Return false when the screen on show already says the same thing
   * live (the trip screen, the driver's offer pop-up).
   */
  showInForeground: (data: PushData, pathname: string) => boolean;
  /** A notification was tapped: open the right screen. */
  onOpen: (data: PushData) => void;
}

/**
 * Mounted once in each app's root layout. Keeps this install's push token
 * registered while signed in, decides what shows while the app is open, and
 * routes taps — including the tap that launched the app from closed, which
 * waits until sign-in has loaded and the app is past its start screen.
 * Never asks for permission (see usePushPermissionPrompt).
 */
export function PushNotifications({ app, showInForeground, onOpen }: PushNotificationsProps) {
  const { user, isLoading } = useAuth();
  const signedIn = user !== null && user.role === (app === "rider" ? "RIDER" : "DRIVER");
  const pathname = usePathname();
  const segments = useSegments();

  const live = useRef({ signedIn, pathname, showInForeground, onOpen });
  live.current = { signedIn, pathname, showInForeground, onOpen };

  // While the app is open: ride notifications show unless the current screen
  // covers it; admin notifications (no screen ever covers them) always show;
  // anything after sign-out, or not ours, stays quiet.
  useEffect(() => {
    if (!pushSupported()) return;
    Notifications.setNotificationHandler({
      handleNotification: async (notification) => {
        const raw = notification.request.content.data;
        const data = parsePushData(raw);
        const show =
          live.current.signedIn &&
          (isAnnouncementPushData(raw) ||
            (data !== null && live.current.showInForeground(data, live.current.pathname)));
        return {
          shouldShowBanner: show,
          shouldShowList: show,
          shouldPlaySound: show,
          shouldSetBadge: false,
        };
      },
    });
    return () => Notifications.setNotificationHandler(null);
  }, []);

  // Register on each signed-in launch, and again if the phone's token changes.
  // The listener also fires after every fetch of the token, unchanged or not,
  // so it hands over the token it got: fetching it again from here would fire
  // it again, forever (registerForPush ignores a token it has just used).
  const userId = signedIn ? user.id : null;
  useEffect(() => {
    if (!userId || !pushSupported()) return;
    void registerForPush(app, userId);
    const subscription = Notifications.addPushTokenListener(
      (devicePushToken) => void registerForPush(app, userId, { devicePushToken }),
    );
    return () => {
      subscription.remove();
      stopPushRegistration();
    };
  }, [userId, app]);

  // Taps. The app is ready once it has left its start screen ("/" before
  // sign-in loads) and isn't on the sign-in screens.
  const response = Notifications.useLastNotificationResponse();
  const ready = !isLoading && signedIn && segments.length > 0 && segments[0] !== "auth";
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!response || !ready) return;
    if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    const id = response.notification.request.identifier;
    if (handled.current === id) return;
    handled.current = id;
    void Notifications.clearLastNotificationResponseAsync();
    const data = parsePushData(response.notification.request.content.data);
    if (data) live.current.onOpen(data);
  }, [response, ready]);

  return null;
}

let promptedThisSession = false;

/**
 * Opens the notification explanation screen once per install, after login,
 * at a calm moment (the caller passes `enabled: false` mid-ride). Never on
 * first launch: the caller sits behind sign-in.
 */
export function usePushPermissionPrompt(enabled: boolean, open: () => void): void {
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    if (!enabled || promptedThisSession || !pushSupported()) return;
    let cancelled = false;
    void (async () => {
      // Keychain unreadable right now (phone locked): ask at the next chance instead.
      const asked = await hasAskedForPush().catch(() => true);
      if (asked) return;
      if ((await getPushPermission()) !== "undetermined") {
        // Decided already (e.g. in system settings): never prompt.
        await markAskedForPush();
        return;
      }
      if (cancelled || promptedThisSession) return;
      promptedThisSession = true;
      openRef.current();
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);
}

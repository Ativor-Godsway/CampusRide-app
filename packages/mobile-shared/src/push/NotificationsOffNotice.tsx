import { useCallback, useEffect, useState } from "react";
import { AppState, Linking, StyleSheet, View } from "react-native";
import * as SecureStore from "expo-secure-store";
import { Button, Notice, spacing } from "../design";
import { KEYCHAIN_BACKGROUND_OPTIONS, readKeychain } from "../auth/keychain";
import { getPushPermission, type PushPermission } from "./registration";

/**
 * The phone's notification permission for this app, read again each time
 * the app comes back to the foreground (the person may have changed it in
 * the phone's settings). Null until known.
 */
export function usePushPermission(): PushPermission | null {
  const [permission, setPermission] = useState<PushPermission | null>(null);
  useEffect(() => {
    let mounted = true;
    const read = () =>
      void getPushPermission().then(
        (next) => mounted && setPermission(next),
        () => {},
      );
    read();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") read();
    });
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);
  return permission;
}

/** "Notifications are off": one line, Open settings, and (optionally) Not now. */
export function NotificationsOffNotice({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  return (
    <View style={styles.notice}>
      <Notice tone="warning" icon="notifications-off-outline" message={message} />
      <View style={styles.actions}>
        <Button
          label="Open settings"
          variant="secondary"
          size="md"
          onPress={() => {
            onDismiss?.();
            void Linking.openSettings();
          }}
        />
        {onDismiss ? <Button label="Not now" variant="text" size="md" onPress={onDismiss} /> : null}
      </View>
    </View>
  );
}

const REMINDED_KEY = "rida.push.offReminderShown";

/**
 * The rider app's reminder, shown ONCE per install: only when the person
 * said "Don't allow" (never while the system prompt is still to come), and
 * counted as shown the moment it appears — so it never nags.
 */
export function useNotificationsOffReminderOnce(enabled: boolean): { show: boolean; dismiss: () => void } {
  const permission = usePushPermission();
  const [state, setState] = useState<"unknown" | "show" | "hidden">("unknown");

  useEffect(() => {
    if (!enabled || permission !== "denied" || state !== "unknown") return;
    let cancelled = false;
    void readKeychain(REMINDED_KEY).then(
      (seen) => {
        if (cancelled) return;
        if (seen === "1") return setState("hidden");
        setState("show");
        void SecureStore.setItemAsync(REMINDED_KEY, "1", KEYCHAIN_BACKGROUND_OPTIONS).catch(() => {});
      },
      // Keychain unreadable right now: not this time.
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [enabled, permission, state]);

  const dismiss = useCallback(() => setState("hidden"), []);
  // Turned back on in settings: gone at once.
  return { show: state === "show" && permission === "denied", dismiss };
}

const styles = StyleSheet.create({
  notice: { gap: spacing[2] },
  actions: { flexDirection: "row", gap: spacing[2], alignItems: "center" },
});

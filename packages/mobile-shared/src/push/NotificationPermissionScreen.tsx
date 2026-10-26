import { useCallback, useEffect, useState } from "react";
import { AppState, Linking, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { PushApp } from "@rida/shared";
import { useAuth } from "../auth/AuthContext";
import { BackButton, Button, Screen, Text, colors, spacing } from "../design";
import {
  getPushPermission,
  markAskedForPush,
  registerForPush,
  requestPushPermission,
  type PushPermission,
} from "./registration";

export interface NotificationPermissionScreenProps {
  app: PushApp;
  /** What turning notifications on gets this person, one short line each. */
  reasons: ReadonlyArray<{ icon: keyof typeof Ionicons.glyphMap; text: string }>;
  /** Leave the screen (allowed, declined or "Not now"). */
  onDone: () => void;
  /** A round Back at the top (it does what "Not now" does). */
  backButton?: boolean;
}

/**
 * The short explanation shown before the system's notification prompt —
 * after login, never at first launch — and from Account › Notifications
 * later. The system prompt appears only when the person taps "Turn on".
 * A plain white page: title, a few lines, one primary action and "Not now".
 */
export function NotificationPermissionScreen({
  app,
  reasons,
  onDone,
  backButton = false,
}: NotificationPermissionScreenProps) {
  const userId = useAuth().user?.id ?? null;
  const [permission, setPermission] = useState<PushPermission | null>(null);
  const [asking, setAsking] = useState(false);

  const refresh = useCallback(async () => {
    const next = await getPushPermission();
    setPermission(next);
    if (next === "granted" && userId) void registerForPush(app, userId);
  }, [app, userId]);

  useEffect(() => {
    // Seeing this screen counts as asked: it never opens by itself again.
    void markAskedForPush();
    void refresh();
    // Back from system settings: pick up a change made there.
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  const turnOn = async () => {
    setAsking(true);
    try {
      const result = await requestPushPermission(app, userId);
      setPermission(result);
      if (result === "granted") onDone();
    } finally {
      setAsking(false);
    }
  };

  const heading =
    permission === "granted"
      ? "Notifications are on"
      : permission === "denied"
        ? "Notifications are off"
        : "Turn on notifications";
  const lead =
    permission === "unsupported"
      ? "Notifications work in the installed app. They're not available in Expo Go or on a simulator."
      : permission === "denied"
        ? "You turned them off for CampusRide. You can turn them back on in your phone's settings."
        : permission === "granted"
          ? "You'll hear from us when something changes with your ride."
          : "So you don't have to keep the app open:";

  return (
    <Screen edges={["top", "bottom"]} style={styles.screen}>
      <View style={styles.body}>
        {backButton ? <BackButton onPress={onDone} style={styles.back} /> : null}
        <Text variant="title1" accessibilityRole="header">
          {heading}
        </Text>
        <Text variant="body" color="secondary">
          {lead}
        </Text>
        {permission !== "unsupported" && permission !== "granted" && (
          <View style={styles.reasons}>
            {reasons.map((reason) => (
              <View key={reason.text} style={styles.reason}>
                <Ionicons name={reason.icon} size={22} color={colors.green700} />
                <Text variant="body" style={styles.reasonText}>
                  {reason.text}
                </Text>
              </View>
            ))}
          </View>
        )}
      </View>

      <View style={styles.actions}>
        {permission === "undetermined" && (
          <Button label="Turn on notifications" onPress={turnOn} loading={asking} />
        )}
        {permission === "denied" && (
          <Button label="Open settings" onPress={() => void Linking.openSettings()} />
        )}
        <Button
          label={permission === "undetermined" || permission === "denied" ? "Not now" : "Done"}
          variant="text"
          onPress={onDone}
          disabled={asking}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  screen: {
    justifyContent: "space-between",
    backgroundColor: colors.surface,
  },
  body: {
    gap: spacing[3],
    paddingTop: spacing[10],
  },
  back: {
    marginTop: -spacing[8],
    marginBottom: spacing[4],
  },
  reasons: {
    gap: spacing[4],
    marginTop: spacing[4],
  },
  reason: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[3],
  },
  reasonText: {
    flex: 1,
  },
  actions: {
    gap: spacing[2],
    paddingBottom: spacing[4],
  },
});

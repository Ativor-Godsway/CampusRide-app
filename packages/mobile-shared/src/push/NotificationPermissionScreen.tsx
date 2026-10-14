import { useCallback, useEffect, useState } from "react";
import { AppState, Linking, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { PushApp } from "@rida/shared";
import { Button, Screen, ServiceIcon, Text, colors, spacing } from "../design";
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
}

/**
 * The short explanation shown before the system's notification prompt —
 * after login, never at first launch — and from Account › Notifications
 * later. The system prompt appears only when the person taps "Turn on".
 */
export function NotificationPermissionScreen({
  app,
  reasons,
  onDone,
}: NotificationPermissionScreenProps) {
  const [permission, setPermission] = useState<PushPermission | null>(null);
  const [asking, setAsking] = useState(false);

  const refresh = useCallback(async () => {
    const next = await getPushPermission();
    setPermission(next);
    if (next === "granted") void registerForPush(app);
  }, [app]);

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
      const result = await requestPushPermission(app);
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
        <ServiceIcon
          name="notifications-outline"
          color={colors.primary[500]}
          background={colors.primary[50]}
          size={64}
        />
        <Text variant="h1" style={styles.heading}>
          {heading}
        </Text>
        <Text variant="body" color="muted">
          {lead}
        </Text>
        {permission !== "unsupported" && permission !== "granted" && (
          <View style={styles.reasons}>
            {reasons.map((reason) => (
              <View key={reason.text} style={styles.reason}>
                <Ionicons name={reason.icon} size={22} color={colors.primary[500]} />
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
          variant="ghost"
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
  },
  body: {
    gap: spacing.md,
    paddingTop: spacing["2xl"],
  },
  heading: {
    marginTop: spacing.md,
  },
  reasons: {
    gap: spacing.lg,
    marginTop: spacing.lg,
  },
  reason: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  reasonText: {
    flex: 1,
  },
  actions: {
    gap: spacing.sm,
    paddingBottom: spacing.lg,
  },
});

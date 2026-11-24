import { useState } from "react";
import { Alert, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { ServiceView } from "@rida/shared";
import { Button, Text, colors, radii, spacing } from "@rida/mobile-shared";

/**
 * Service hours on Home (@rida/shared service/serviceHours.ts):
 * - closed: "CampusRide is closed. We're back at 8:00 AM tomorrow." (or the
 *   admin's own message), with "Notify me when you open";
 * - open hours with no driver online: "No drivers online right now – try again shortly.";
 * - the last 30 minutes before closing: a soft "Closes at 5:00 PM".
 * Browsing and choosing places still work; Choose a ride disables Request.
 */
export function ServiceHoursBanner({
  view,
  notifyMe,
  setNotifyMe,
}: {
  view: ServiceView;
  notifyMe: boolean;
  setNotifyMe: (on: boolean) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);

  if (view.kind === "open") {
    if (!view.closingSoon) return null;
    return (
      <View style={styles.soft} accessibilityRole="text">
        <Ionicons name="time-outline" size={16} color={colors.ink3} />
        <Text variant="subhead" color="secondary">
          {view.closingSoon}
        </Text>
      </View>
    );
  }

  async function toggle() {
    setBusy(true);
    try {
      await setNotifyMe(!notifyMe);
    } catch {
      Alert.alert("Couldn't save that", "CampusRide may have just opened. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const title = view.title;
  const detail = view.kind === "closed" ? view.detail : null;
  return (
    <View style={styles.card} accessibilityRole="alert" accessibilityLiveRegion="polite">
      <View style={styles.row}>
        <Ionicons
          name={view.kind === "closed" ? "moon-outline" : "car-outline"}
          size={22}
          color={colors.amber700}
        />
        <View style={styles.words}>
          <Text variant="title3" style={styles.text}>
            {title}
          </Text>
          {detail ? (
            <Text variant="subhead" style={styles.text}>
              {detail}
            </Text>
          ) : null}
        </View>
      </View>
      <Button
        label={notifyMe ? "We'll notify you when we open" : "Notify me when you open"}
        variant="secondary"
        size="md"
        loading={busy}
        onPress={() => void toggle()}
        accessibilityHint={notifyMe ? "Tap to stop the notification" : "One notification when CampusRide opens"}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: spacing[3],
    padding: spacing[4],
    borderRadius: radii.lg,
    backgroundColor: colors.amber50,
  },
  row: {
    flexDirection: "row",
    gap: spacing[3],
    alignItems: "flex-start",
  },
  words: {
    flex: 1,
    gap: spacing[1],
  },
  text: {
    color: colors.amber700,
  },
  soft: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[2],
  },
});

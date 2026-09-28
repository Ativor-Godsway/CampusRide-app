import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { DISPATCH_WINDOW_MS, dispatchSecondsLeft, type RideType } from "@rida/shared";
import {
  Button,
  Illustration,
  ProgressBar,
  RouteStops,
  Text,
  colors,
  radii,
  spacing,
} from "@rida/mobile-shared";
import { SafetyTipCard } from "./SafetyTipCard";

function formatClock(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * "Finding your driver". Everything shown is real state:
 * - the status line says what the server is actually doing with this ride
 *   type (a SHARED request is offered to free drivers AND to drivers already
 *   filling a car on the way);
 * - the bar is the real 90s dispatch window counting down from the server's
 *   broadcastStartedAt, labelled as such. When it runs out we say "still
 *   searching" — the server's sweep can take a few more seconds to move the
 *   ride to "no drivers", and it is not a failure until it does.
 */
export function SearchingPanel({
  pickupZoneName,
  dropoffZoneName,
  rideType,
  priceLabel,
  broadcastStartedAt,
  onCancel,
}: {
  pickupZoneName: string;
  dropoffZoneName: string;
  rideType: RideType;
  priceLabel: string;
  /** From the server; undefined until the ride is first fetched. */
  broadcastStartedAt: Date | string | null | undefined;
  onCancel: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const secondsLeft = dispatchSecondsLeft(broadcastStartedAt, now);
  const status =
    rideType === "SHARED"
      ? `Looking for a driver or a shared car going your way from ${pickupZoneName}…`
      : `Contacting drivers near ${pickupZoneName}…`;

  return (
    <View style={styles.section}>
      <View style={styles.hero}>
        <Illustration name="pinRadar" size={132} pulse float />
      </View>

      <View style={styles.heading} accessibilityLiveRegion="polite">
        <Text variant="h2" style={styles.centered} accessibilityRole="header">
          Finding your driver
        </Text>
        <Text variant="bodySmall" color="muted" style={styles.centered}>
          {status}
        </Text>
      </View>

      <View style={styles.window}>
        {secondsLeft === null ? (
          <Text variant="caption" color="subtle" style={styles.centered}>
            Sending your request…
          </Text>
        ) : (
          <>
            <ProgressBar progress={(secondsLeft * 1000) / DISPATCH_WINDOW_MS} height={4} />
            <Text variant="caption" color="subtle" style={styles.centered}>
              {secondsLeft > 0
                ? `Offering your ride to drivers · about ${formatClock(secondsLeft)} left`
                : "Still searching — if no one's free, we'll ask what you'd like to do."}
            </Text>
          </>
        )}
      </View>

      <View style={styles.summary}>
        <RouteStops
          connectorHeight={12}
          origin={
            <Text variant="bodyMedium" numberOfLines={1}>
              {pickupZoneName}
            </Text>
          }
          destination={
            <Text variant="bodyMedium" numberOfLines={1}>
              {dropoffZoneName}
            </Text>
          }
        />
        <View style={styles.divider} />
        <View style={styles.summaryRow}>
          <Illustration name={rideType === "SHARED" ? "carShared" : "carStandard"} width={56} />
          <View style={styles.summaryText}>
            <Text variant="bodyMedium">{rideType === "SHARED" ? "Shared" : "Ride alone"}</Text>
            <View style={styles.cashRow}>
              <Ionicons name="cash-outline" size={13} color={colors.ink[400]} />
              <Text variant="caption" color="muted">
                Cash
              </Text>
            </View>
          </View>
          <Text variant="h3">{priceLabel}</Text>
        </View>
      </View>

      <SafetyTipCard />

      <Button label="Cancel request" variant="secondary" onPress={onCancel} />
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing.lg },
  hero: { alignItems: "center", marginTop: spacing.xs },
  heading: { gap: spacing.xs, paddingHorizontal: spacing.sm },
  centered: { textAlign: "center" },
  window: { gap: spacing.sm },
  summary: {
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
    backgroundColor: colors.white,
  },
  divider: { height: 1, backgroundColor: colors.hairline },
  summaryRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  summaryText: { flex: 1, gap: 2 },
  cashRow: { flexDirection: "row", alignItems: "center", gap: 4 },
});

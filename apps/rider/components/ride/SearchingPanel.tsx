import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { DISPATCH_WINDOW_MS, dispatchSecondsLeft, type RideType } from "@rida/shared";
import {
  Button,
  Card,
  Illustration,
  ProgressBar,
  RouteStops,
  Text,
  colors,
  spacing,
} from "@rida/mobile-shared";

/** One calm tip for the wait: the check that matters most at pickup. */
export const SAFETY_TIP = "Check the car's plate matches before you get in.";

/**
 * "Finding your driver": a compact sheet over the map, where the pickup
 * pulses. Everything shown is real state: the thin line along the top of the
 * card is the 90 s dispatch window running down from the server's
 * broadcastStartedAt ("usually under 2 minutes" is that window, plus the few
 * seconds the server takes to say no one was free).
 */
export function SearchingPanel({
  pickupZoneName,
  pickupPlaceName,
  dropoffZoneName,
  rideType,
  priceLabel,
  broadcastStartedAt,
  onCancel,
}: {
  /** The pickup as listed in the card ("Current location" is fine there). */
  pickupZoneName: string;
  /** A real place name for the sentence (pickupPlace), or null: "near you". */
  pickupPlaceName: string | null;
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

  return (
    <View style={styles.section}>
      <View style={styles.heading} accessibilityLiveRegion="polite">
        <Text variant="title2" accessibilityRole="header">
          Finding your driver
        </Text>
        <Text variant="subhead" color="secondary">
          Asking drivers near {pickupPlaceName ?? "you"} · usually under 2 minutes
        </Text>
      </View>

      <Card variant="filled" style={styles.card}>
        <View importantForAccessibility="no-hide-descendants">
          <ProgressBar
            progress={secondsLeft === null ? 1 : (secondsLeft * 1000) / DISPATCH_WINDOW_MS}
            height={3}
            color={colors.green500}
            trackColor={colors.surface3}
          />
        </View>
        <RouteStops
          connectorHeight={12}
          origin={
            <Text variant="bodyStrong" numberOfLines={1}>
              {pickupZoneName}
            </Text>
          }
          destination={
            <Text variant="bodyStrong" numberOfLines={1}>
              {dropoffZoneName}
            </Text>
          }
        />
        <View style={styles.divider} />
        <View style={styles.rideRow}>
          <Illustration name={rideType === "SHARED" ? "carShared" : "carStandard"} width={56} />
          <View style={styles.rideText}>
            <Text variant="bodyStrong">{rideType === "SHARED" ? "Shared" : "Ride alone"}</Text>
            <Text variant="subhead" color="secondary">
              Cash
            </Text>
          </View>
          <Text variant="title3" tabular>
            {priceLabel}
          </Text>
        </View>
      </Card>

      <View style={styles.tip} accessible accessibilityLabel={`Safety tip: ${SAFETY_TIP}`}>
        <Ionicons name="shield-checkmark-outline" size={16} color={colors.ink3} />
        <Text variant="subhead" color="secondary" style={styles.tipText}>
          {SAFETY_TIP}
        </Text>
      </View>

      <Button label="Cancel" variant="danger" onPress={onCancel} />
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing[4] },
  heading: { gap: spacing[1] },
  card: { gap: spacing[3] },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line },
  rideRow: { flexDirection: "row", alignItems: "center", gap: spacing[3] },
  rideText: { flex: 1, gap: 2 },
  tip: { flexDirection: "row", alignItems: "center", gap: spacing[2] },
  tipText: { flex: 1 },
});

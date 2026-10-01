import { StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import {
  PressableScale,
  Text,
  colors,
  spacing,
  withAlpha,
  type RideWithZones,
} from "@rida/mobile-shared";
import { tripHref, tripStatusLine } from "../lib/activeTrip";

/**
 * "You're on a trip" bar across the top of every driver tab. Tapping it goes
 * back to the trip screen (Ride alone and Shared alike).
 */
export function ActiveTripBanner({ ride }: { ride: RideWithZones }) {
  const router = useRouter();
  const status = tripStatusLine(ride);
  const href = tripHref(ride);

  return (
    <SafeAreaView edges={["top"]} style={styles.safeArea}>
      <PressableScale
        onPress={() => router.push(href)}
        accessibilityRole="button"
        accessibilityLabel={`${status}. Open your trip.`}
        style={styles.banner}
      >
        <Ionicons name="car-sport" size={20} color={colors.white} />
        <View style={styles.text}>
          <Text variant="bodyMedium" color="inverse" style={styles.status} numberOfLines={2}>
            {status}
          </Text>
          <Text variant="bodySmall" style={styles.hint}>
            Tap to return to your trip
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={20} color={colors.white} />
      </PressableScale>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { backgroundColor: colors.primary[500] },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: 56,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  text: { flex: 1, gap: 1 },
  status: { fontWeight: "700" },
  hint: { color: withAlpha(colors.white, 0.85) },
});

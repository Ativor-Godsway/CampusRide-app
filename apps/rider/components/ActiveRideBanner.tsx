import { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import {
  PressableScale,
  Text,
  colors,
  radii,
  spacing,
  useReduceMotion,
  withAlpha,
  type ActiveRideSummary,
} from "@rida/mobile-shared";
import { activeRideParams } from "../lib/activeRide";
import { useActiveRideStatus } from "../lib/activeRideStatus";

/** A soft pulsing dot: "this is live". Still with Reduce Motion on. */
function LiveDot() {
  const reduceMotion = useReduceMotion();
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduceMotion) return;
    const loop = Animated.loop(
      Animated.timing(pulse, {
        toValue: 1,
        duration: 1400,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, reduceMotion]);
  return (
    <View style={styles.dotWrap} importantForAccessibility="no-hide-descendants">
      {!reduceMotion ? (
        <Animated.View
          style={[
            styles.dotRing,
            {
              opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.6, 0] }),
              transform: [
                { scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 2.4] }) },
              ],
            },
          ]}
        />
      ) : null}
      <View style={styles.dot} />
    </View>
  );
}

/**
 * The "you have a ride going on" bar across the top of the Rides and Account
 * tabs (Home shows it as the first row of its sheet). Tapping it reopens the
 * ride screen. Rendered by the tabs layout.
 */
export function ActiveRideBanner({ ride }: { ride: ActiveRideSummary }) {
  const router = useRouter();
  const { line: status, destination } = useActiveRideStatus(ride);

  return (
    <SafeAreaView edges={["top"]} style={styles.safeArea}>
      <PressableScale
        onPress={() => router.push({ pathname: "/ride/type", params: activeRideParams(ride) })}
        accessibilityRole="button"
        accessibilityLabel={`${status}. Ride to ${destination}. Open your ride.`}
        style={styles.banner}
      >
        <LiveDot />
        <View style={styles.text}>
          <Text variant="bodyMedium" color="inverse" style={styles.status} numberOfLines={2}>
            {status}
          </Text>
          <Text variant="bodySmall" style={styles.route} numberOfLines={1}>
            To {destination}
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
  route: { color: withAlpha(colors.white, 0.85) },
  dotWrap: { width: 14, height: 14, alignItems: "center", justifyContent: "center" },
  dot: { width: 10, height: 10, borderRadius: radii.full, backgroundColor: colors.white },
  dotRing: {
    position: "absolute",
    width: 10,
    height: 10,
    borderRadius: radii.full,
    backgroundColor: colors.white,
  },
});

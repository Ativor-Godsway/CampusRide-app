import { useCallback, useEffect, useRef, useState } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { activeRideStatusLine, estimateEtaMinutes } from "@rida/shared";
import {
  PressableScale,
  Text,
  colors,
  radii,
  spacing,
  subscribeToRide,
  useDriverLocation,
  useReduceMotion,
  withAlpha,
  type ActiveRideSummary,
} from "@rida/mobile-shared";
import { activeRideParams } from "../lib/activeRide";

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
 * The "you have a ride going on" bar across the top of every tab. Tapping it
 * reopens the ride screen. Rendered by the tabs layout, so it can't be
 * missed whichever tab the rider is on.
 */
export function ActiveRideBanner({ ride }: { ride: ActiveRideSummary }) {
  const router = useRouter();
  const [driverAt, setDriverAt] = useState<{ latitude: number; longitude: number } | null>(null);
  const waitingForDriver = ride.status === "MATCHED" || ride.status === "ARRIVED";

  // Driver location pings arrive on the ride's socket room. The ride screen
  // leaves that room when it closes, so re-join whenever the tabs are back
  // in view (joining twice is harmless; the server just keeps us in).
  useFocusEffect(
    useCallback(() => {
      if (waitingForDriver) subscribeToRide(ride.id);
    }, [ride.id, waitingForDriver]),
  );
  useDriverLocation(waitingForDriver ? ride.id : undefined, (payload) =>
    setDriverAt({ latitude: payload.lat, longitude: payload.lng }),
  );

  const status = activeRideStatusLine({
    status: ride.status,
    type: ride.type,
    legStatus: ride.legStatus,
    driverFirstName: ride.driver?.firstName,
    etaMinutes: waitingForDriver ? estimateEtaMinutes(driverAt, ride.pickupZone) : null,
  });

  return (
    <SafeAreaView edges={["top"]} style={styles.safeArea}>
      <PressableScale
        onPress={() => router.push({ pathname: "/ride/type", params: activeRideParams(ride) })}
        accessibilityRole="button"
        accessibilityLabel={`${status}. Ride to ${ride.dropoffZone.name}. Open your ride.`}
        style={styles.banner}
      >
        <LiveDot />
        <View style={styles.text}>
          <Text variant="bodyMedium" color="inverse" style={styles.status} numberOfLines={2}>
            {status}
          </Text>
          <Text variant="bodySmall" style={styles.route} numberOfLines={1}>
            To {ride.dropoffZone.name}
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

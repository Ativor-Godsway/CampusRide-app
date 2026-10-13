import { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import { colors } from "@rida/mobile-shared";

/**
 * A thin countdown along the top edge of a card: full at the start, empty
 * at `deadline`. Takes no room of its own (the mid-trip rider offer uses it
 * instead of the ring). Linear — it's a clock — and it keeps running with
 * Reduce Motion on, since it's information.
 */
export function CountdownBar({ deadline, totalMs, height = 4 }: { deadline: number; totalMs: number; height?: number }) {
  const left = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const remaining = Math.max(0, deadline - Date.now());
    left.setValue(remaining / Math.max(1, totalMs));
    const anim = Animated.timing(left, { toValue: 0, duration: remaining, easing: Easing.linear, useNativeDriver: false });
    anim.start();
    return () => anim.stop();
  }, [deadline, totalMs, left]);

  const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  return (
    <View
      style={[styles.track, { height }]}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={`About ${seconds} seconds to add this rider`}
    >
      <Animated.View
        style={[
          styles.fill,
          {
            width: left.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] }),
            backgroundColor: left.interpolate({
              inputRange: [0, 0.33, 0.34, 1],
              outputRange: [colors.warning, colors.warning, colors.primary[500], colors.primary[500]],
            }),
          },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  track: { position: "absolute", top: 0, left: 0, right: 0, backgroundColor: "transparent" },
  fill: { height: "100%" },
});

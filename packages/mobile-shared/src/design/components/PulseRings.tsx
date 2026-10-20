import { useEffect, type ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { colors } from "../tokens";
import { useReduceMotion } from "./Illustration";

/** One ring's trip outwards (docs/design-system.md: 2 rings over 1.6 s). */
export const PULSE_MS = 1600;
const START_OPACITY = 0.22;

export interface PulseRingsProps {
  /** The rings' widest point (diameter). */
  size?: number;
  color?: string;
  /** What the rings pulse around (a pin, the car), centred on top. */
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
}

/**
 * The live "searching" pulse: two rings expanding from a point, green at
 * 22% fading to nothing, the second half a cycle behind the first. With
 * Reduce Motion on they stand still, faint.
 */
export function PulseRings({
  size = 160,
  color = colors.green500,
  children,
  style,
}: PulseRingsProps) {
  const reduceMotion = useReduceMotion();
  return (
    <View style={[{ width: size, height: size }, styles.center, style]} pointerEvents="none">
      <Ring size={size} color={color} delay={0} still={reduceMotion ? 0.55 : null} />
      <Ring size={size} color={color} delay={PULSE_MS / 2} still={reduceMotion ? 1 : null} />
      {children}
    </View>
  );
}

function Ring({
  size,
  color,
  delay,
  still,
}: {
  size: number;
  color: string;
  delay: number;
  still: number | null;
}) {
  const progress = useSharedValue(still ?? 0);

  useEffect(() => {
    if (still !== null) {
      cancelAnimation(progress);
      progress.value = still;
      return;
    }
    progress.value = 0;
    progress.value = withDelay(
      delay,
      withRepeat(withTiming(1, { duration: PULSE_MS, easing: Easing.out(Easing.quad) }), -1, false),
    );
    return () => cancelAnimation(progress);
  }, [still, delay, progress]);

  const animated = useAnimatedStyle(() => ({
    opacity: still !== null ? START_OPACITY / 3 : START_OPACITY * (1 - progress.value),
    transform: [{ scale: 0.15 + 0.85 * progress.value }],
  }));

  return (
    <Animated.View
      style={[
        styles.ring,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: color },
        animated,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  center: {
    alignItems: "center",
    justifyContent: "center",
  },
  ring: {
    position: "absolute",
  },
});

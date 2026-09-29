import { useEffect, useRef } from "react";
import {
  Animated,
  Easing,
  StyleSheet,
  View,
  type DimensionValue,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { colors, radii, spacing } from "../tokens";
import { useReduceMotion } from "./Illustration";

/**
 * One shared "breathing" value per skeleton group, so every block in a
 * placeholder pulses in step instead of flickering independently.
 */
function useSkeletonPulse(): Animated.Value {
  const reduceMotion = useReduceMotion();
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (reduceMotion) {
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 0.45,
          duration: 700,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 1,
          duration: 700,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, reduceMotion]);
  return pulse;
}

export interface SkeletonProps {
  width?: DimensionValue;
  height?: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}

/**
 * A grey placeholder block shown in the exact place content will appear,
 * so a loading screen already has its final shape (no blank space, no
 * layout jump). Static with Reduce Motion on. Hidden from screen readers —
 * wrap a group in <SkeletonGroup label="Loading …"> to announce it once.
 */
export function Skeleton({ width = "100%", height = 14, radius = radii.sm, style }: SkeletonProps) {
  const pulse = useSkeletonPulse();
  return (
    <Animated.View
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={[styles.block, { width, height, borderRadius: radius, opacity: pulse }, style]}
    />
  );
}

/** Announces a loading region once, instead of once per grey block. */
export function SkeletonGroup({
  label,
  children,
  style,
}: {
  label: string;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={style} accessible accessibilityLabel={label} accessibilityState={{ busy: true }}>
      {children}
    </View>
  );
}

/** Placeholder for a list of icon + one/two-line rows (recent places, history…). */
export function SkeletonListRows({
  count = 3,
  twoLines = false,
}: {
  count?: number;
  twoLines?: boolean;
}) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={styles.row}>
          <Skeleton width={36} height={36} radius={radii.full} />
          <View style={styles.rowText}>
            <Skeleton width={i % 2 === 0 ? "62%" : "48%"} height={14} />
            {twoLines ? <Skeleton width="34%" height={12} /> : null}
          </View>
        </View>
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  block: { backgroundColor: colors.surfaceSunken },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: spacing.sm },
  rowText: { flex: 1, gap: spacing.xs },
});

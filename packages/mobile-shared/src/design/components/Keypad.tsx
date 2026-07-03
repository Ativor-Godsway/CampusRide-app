import { StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { Pressable } from "react-native";
import { colors, motion, radii, spacing, typography } from "../tokens";
import { haptics } from "../haptics";

export interface KeypadProps {
  /** A digit key ("0"–"9") was tapped. */
  onDigit: (digit: string) => void;
  /** Backspace tapped. */
  onBackspace: () => void;
  /** Backspace long-pressed — callers usually clear the whole value. */
  onClearAll?: () => void;
  /** Disables all keys (e.g. while auto-verifying an OTP). */
  disabled?: boolean;
}

const ROWS: string[][] = [
  ["1", "2", "3"],
  ["4", "5", "6"],
  ["7", "8", "9"],
  ["", "0", "backspace"],
];

const AnimatedKeyBase = Animated.createAnimatedComponent(Pressable);

/** One key tile: pressed = scale 0.94 + sunken tint, light haptic. */
function Key({
  label,
  onPress,
  onLongPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  onLongPress?: () => void;
  disabled?: boolean;
}) {
  const pressed = useSharedValue(0);
  const isBackspace = label === "backspace";

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 - pressed.value * 0.06 }],
    backgroundColor: interpolateColor(
      pressed.value,
      [0, 1],
      [colors.white, colors.surfaceSunken],
    ),
  }));

  return (
    <AnimatedKeyBase
      accessibilityRole="button"
      accessibilityLabel={isBackspace ? "Delete" : label}
      accessibilityHint={isBackspace ? "Long-press to clear all" : undefined}
      disabled={disabled}
      onPressIn={() => {
        pressed.value = withSpring(1, motion.spring.snappy);
      }}
      onPressOut={() => {
        pressed.value = withSpring(0, motion.spring.snappy);
      }}
      onPress={() => {
        haptics.light();
        onPress();
      }}
      onLongPress={
        onLongPress
          ? () => {
              haptics.light();
              onLongPress();
            }
          : undefined
      }
      style={[styles.key, animatedStyle, disabled && styles.keyDisabled]}
    >
      {isBackspace ? (
        <Ionicons name="backspace-outline" size={24} color={colors.ink[700]} />
      ) : (
        <Animated.Text style={styles.digit}>{label}</Animated.Text>
      )}
    </AnimatedKeyBase>
  );
}

/**
 * Custom numeric keypad — replaces the system keyboard for phone entry, OTP,
 * and MoMo payment numbers, so nothing on screen can ever be occluded.
 * 3×4 grid: 1–9, blank, 0, backspace (long-press clears all).
 */
export function Keypad({ onDigit, onBackspace, onClearAll, disabled }: KeypadProps) {
  return (
    <View style={styles.grid}>
      {ROWS.map((row, rowIndex) => (
        <View key={rowIndex} style={styles.row}>
          {row.map((key, keyIndex) =>
            key === "" ? (
              <View key={keyIndex} style={styles.spacer} />
            ) : (
              <Key
                key={keyIndex}
                label={key}
                disabled={disabled}
                onPress={key === "backspace" ? onBackspace : () => onDigit(key)}
                onLongPress={key === "backspace" ? onClearAll : undefined}
              />
            ),
          )}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    gap: spacing.sm,
  },
  row: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  key: {
    flex: 1,
    minHeight: 56,
    borderRadius: radii.md,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.border,
  },
  keyDisabled: {
    opacity: 0.4,
  },
  spacer: {
    flex: 1,
  },
  digit: {
    fontSize: typography.size.lg,
    fontWeight: typography.weight.semibold,
    color: colors.ink[900],
  },
});

import { Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { haptics } from "../haptics";
import { colors, radii, spacing } from "../tokens";
import { Text } from "./Text";

export interface StepperProps {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  /** What the value is, read with it: "1 seat", "3 people". */
  format: (value: number) => string;
  /** What is being chosen, for screen readers: "Seats". */
  accessibilityLabel: string;
  /**
   * Called when + is tapped at `max`. With it, + stays tappable (looking
   * spent) instead of being disabled, so the screen can suggest something.
   */
  onIncrementAtMax?: () => void;
  testID?: string;
}

/**
 * − value + (docs/design-system.md, quiet controls): two 36-pt round
 * buttons on surface-2 around the value, which reads "2 seats". One
 * adjustable element for screen readers (swipe up / down). A tick of
 * selection haptic per change.
 */
export function Stepper({ value, min, max, onChange, format, accessibilityLabel, onIncrementAtMax, testID }: StepperProps) {
  const canDown = value > min;
  const canUp = value < max;
  const change = (next: number) => {
    if (next === value) return;
    haptics.selection();
    onChange(next);
  };
  const up = () => {
    if (canUp) change(value + 1);
    else onIncrementAtMax?.();
  };
  return (
    <View
      style={styles.row}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ min, max, now: value, text: format(value) }}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === "increment") up();
        if (e.nativeEvent.actionName === "decrement" && canDown) change(value - 1);
      }}
      testID={testID}
    >
      <StepButton icon="remove" enabled={canDown} onPress={() => canDown && change(value - 1)} testID={testID ? `${testID}-minus` : undefined} />
      <Text variant="bodyStrong" tabular style={styles.value} numberOfLines={1}>
        {format(value)}
      </Text>
      <StepButton
        icon="add"
        enabled={canUp}
        // Spent but still tappable when the screen has something to say at the top.
        pressable={canUp || !!onIncrementAtMax}
        onPress={up}
        testID={testID ? `${testID}-plus` : undefined}
      />
    </View>
  );
}

function StepButton({
  icon,
  enabled,
  pressable = enabled,
  onPress,
  testID,
}: {
  icon: "add" | "remove";
  enabled: boolean;
  pressable?: boolean;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!pressable}
      hitSlop={6}
      // The row is the one element screen readers see.
      importantForAccessibility="no"
      accessibilityElementsHidden
      style={({ pressed }) => [styles.button, pressed && pressable && styles.pressed]}
      testID={testID}
    >
      <Ionicons name={icon} size={18} color={enabled ? colors.ink : colors.ink4} />
    </Pressable>
  );
}

const SIZE = 36;

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: spacing[2] },
  value: { minWidth: 64, textAlign: "center" },
  button: {
    width: SIZE,
    height: SIZE,
    borderRadius: radii.full,
    backgroundColor: colors.surface2,
    alignItems: "center",
    justifyContent: "center",
  },
  pressed: { backgroundColor: colors.surface3 },
});

import { StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, radii, spacing } from "../tokens";
import { haptics } from "../haptics";
import { Text } from "./Text";
import { AnimatedPressable } from "./AnimatedPressable";

export interface ChipProps {
  label: string;
  /** Selected = green-tint fill + brand border. Parent owns the state (single or multi-select). */
  selected?: boolean;
  onPress?: () => void;
  icon?: keyof typeof Ionicons.glyphMap;
  disabled?: boolean;
}

/** Pill chip — rating tags, filters, campus quick-spots. */
export function Chip({ label, selected = false, onPress, icon, disabled }: ChipProps) {
  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityState={{ selected, disabled: disabled ?? false }}
      disabled={disabled}
      onPress={
        onPress
          ? () => {
              haptics.selection();
              onPress();
            }
          : undefined
      }
      style={[styles.chip, selected && styles.chipSelected, disabled && styles.chipDisabled]}
    >
      <View style={styles.content}>
        {icon ? (
          <Ionicons
            name={icon}
            size={15}
            color={selected ? colors.primary[500] : colors.ink[500]}
          />
        ) : null}
        <Text variant="label" color={selected ? "primary" : "muted"}>
          {label}
        </Text>
      </View>
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    borderRadius: radii.pill,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.white,
    paddingHorizontal: spacing.lg,
    minHeight: 44,
    justifyContent: "center",
  },
  chipSelected: {
    borderColor: colors.primary[500],
    backgroundColor: colors.primary[50],
  },
  chipDisabled: {
    opacity: 0.4,
  },
  content: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
});

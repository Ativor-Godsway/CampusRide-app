import { Pressable, StyleSheet, View } from "react-native";
import { haptics } from "../haptics";
import { colors, radii, shadows, spacing } from "../tokens";
import { Text } from "./Text";

export interface SegmentedControlProps<T extends string> {
  /** Two or three short choices: "Today" / "This week". */
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  /** For VoiceOver / TalkBack: what the choice is about. */
  accessibilityLabel: string;
}

/**
 * Two or three views of the same thing, side by side: a surface-2 track with
 * the chosen one raised in white. A selection haptic on change.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  accessibilityLabel,
}: SegmentedControlProps<T>) {
  return (
    <View style={styles.track} accessibilityRole="tablist" accessibilityLabel={accessibilityLabel}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            onPress={() => {
              if (selected) return;
              haptics.selection();
              onChange(option.value);
            }}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={option.label}
            style={[styles.segment, selected && styles.selected]}
          >
            <Text variant="subhead" style={[styles.label, selected && styles.labelSelected]}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: "row",
    padding: 3,
    borderRadius: radii.md,
    backgroundColor: colors.surface2,
  },
  segment: {
    flex: 1,
    minHeight: 36,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing[3],
    borderRadius: radii.md - 3,
  },
  selected: { backgroundColor: colors.surface, ...shadows.float },
  label: { color: colors.ink2, fontWeight: "600" },
  labelSelected: { color: colors.ink, fontWeight: "700" },
});

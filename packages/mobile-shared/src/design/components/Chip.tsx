import {
  Animated,
  Pressable,
  StyleSheet,
  View,
  type PressableProps,
  type ViewProps,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { haptics } from "../haptics";
import { colors, radii, sizes, spacing } from "../tokens";
import { usePressScale } from "./Motion";
import { Text } from "./Text";

/**
 * docs/design-system.md, "Chip". 36 tall, hit area padded to 48.
 * - `filter`: one selected at a time (All / Shared / Private); selected = ink fill, white text.
 * - `choice`: cancel reasons, rating tags; selected = green-50, green border, green text and a check.
 * - `place`: recent destinations; white with a line border and a clock icon.
 */
export type ChipKind = "filter" | "choice" | "place";

export interface ChipProps extends Omit<PressableProps, "style" | "children"> {
  label: string;
  kind?: ChipKind;
  selected?: boolean;
  /** Leading Ionicons glyph. A `place` chip defaults to a clock. */
  icon?: keyof typeof Ionicons.glyphMap;
}

export function Chip({
  label,
  kind = "filter",
  selected = false,
  icon,
  onPress,
  onPressIn,
  onPressOut,
  ...rest
}: ChipProps) {
  const { scale, pressIn, pressOut } = usePressScale();
  const leading = icon ?? (kind === "place" ? "time-outline" : undefined);
  const look = selected ? SELECTED[kind] : REST[kind];

  return (
    <Pressable
      accessibilityRole={kind === "place" ? "button" : "checkbox"}
      accessibilityState={kind === "place" ? undefined : { checked: selected }}
      accessibilityLabel={label}
      hitSlop={6}
      onPress={(e) => {
        if (kind !== "place") haptics.selection();
        onPress?.(e);
      }}
      onPressIn={(e) => {
        pressIn();
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        pressOut();
        onPressOut?.(e);
      }}
      {...rest}
    >
      {({ pressed }) => (
        <Animated.View
          style={[
            styles.chip,
            { backgroundColor: look.fill, borderColor: look.border, transform: [{ scale }] },
            pressed && !selected && kind !== "place" && { backgroundColor: colors.surface3 },
            pressed && kind === "place" && { backgroundColor: colors.surface2 },
          ]}
        >
          {kind === "choice" && selected ? (
            <Ionicons name="checkmark" size={18} color={look.text} />
          ) : leading ? (
            <Ionicons name={leading} size={18} color={kind === "place" ? colors.ink2 : look.text} />
          ) : null}
          <Text variant="subhead" style={[styles.label, { color: look.text }]} numberOfLines={1}>
            {label}
          </Text>
        </Animated.View>
      )}
    </Pressable>
  );
}

type Look = { fill: string; border: string; text: string };

const REST: Record<ChipKind, Look> = {
  filter: { fill: colors.surface2, border: "transparent", text: colors.ink },
  choice: { fill: colors.surface2, border: "transparent", text: colors.ink },
  place: { fill: colors.surface, border: colors.line, text: colors.ink },
};

const SELECTED: Record<ChipKind, Look> = {
  filter: { fill: colors.ink, border: "transparent", text: colors.onDark },
  choice: { fill: colors.green50, border: colors.green500, text: colors.green700 },
  place: REST.place,
};

/** brand: Best value / Online / In car · neutral: Shared · 1 seat · warn: Waiting / Under review · danger: Cancelled · amber: the DRIVER badge. */
export type StatusTone = "brand" | "neutral" | "warn" | "danger" | "amber";

export interface StatusChipProps extends ViewProps {
  /** Always a word: status is never shown as a bare dot. */
  label: string;
  tone?: StatusTone;
  icon?: keyof typeof Ionicons.glyphMap;
}

/** 24px status label, radius-sm, 12/700. */
export function StatusChip({ label, tone = "neutral", icon, style, ...rest }: StatusChipProps) {
  const look = STATUS[tone];
  return (
    <View style={[styles.status, { backgroundColor: look.fill }, style]} {...rest}>
      {icon ? <Ionicons name={icon} size={12} color={look.text} /> : null}
      <Text variant="caption" style={[styles.statusLabel, { color: look.text }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const STATUS: Record<StatusTone, { fill: string; text: string }> = {
  brand: { fill: colors.green50, text: colors.green700 },
  neutral: { fill: colors.surface2, text: colors.ink2 },
  warn: { fill: colors.amber50, text: colors.amber700 },
  danger: { fill: colors.red50, text: colors.red600 },
  amber: { fill: colors.amber400, text: colors.ink },
};

const styles = StyleSheet.create({
  chip: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: spacing[1],
    minHeight: sizes.controlSm,
    paddingHorizontal: spacing[4],
    borderRadius: radii.full,
    borderWidth: 1.5,
  },
  label: {
    fontWeight: "600",
  },
  status: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: spacing[1],
    minHeight: 24,
    paddingHorizontal: spacing[2],
    borderRadius: radii.sm,
  },
  statusLabel: {
    fontWeight: "700",
    letterSpacing: 0,
  },
});

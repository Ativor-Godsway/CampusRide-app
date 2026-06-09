import type { ReactNode } from "react";
import { Pressable, View, StyleSheet, type PressableProps } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, radii, spacing, touchTarget } from "../tokens";
import { Text } from "./Text";

export interface ListRowProps extends Omit<PressableProps, "style" | "children"> {
  title: string;
  subtitle?: string;
  /** Leading element — typically an icon, often via `<ListRow.Icon />`. */
  leading?: ReactNode;
  /** Trailing element — defaults to a chevron when `onPress` is set. */
  trailing?: ReactNode;
  showChevron?: boolean;
}

/**
 * Tappable row with leading/trailing slots — the building block for
 * Uber-style location lists (R2) and settings/trip-history lists.
 */
export function ListRow({
  title,
  subtitle,
  leading,
  trailing,
  showChevron = true,
  onPress,
  ...rest
}: ListRowProps) {
  return (
    <Pressable
      accessibilityRole={onPress ? "button" : undefined}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && !!onPress && styles.pressed]}
      {...rest}
    >
      {leading ? <View style={styles.leading}>{leading}</View> : null}
      <View style={styles.body}>
        <Text variant="bodyMedium" numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="bodySmall" color="muted" numberOfLines={1} style={styles.subtitle}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing ??
        (onPress && showChevron ? (
          <Ionicons name="chevron-forward" size={20} color={colors.ink[300]} />
        ) : null)}
    </Pressable>
  );
}

/** Pre-styled leading icon in a tinted circle — common pattern for ListRow. */
ListRow.Icon = function ListRowIcon({
  name,
  color = colors.primary[600],
  background = colors.primary[50],
}: {
  name: keyof typeof Ionicons.glyphMap;
  color?: string;
  background?: string;
}) {
  return (
    <View style={[styles.iconCircle, { backgroundColor: background }]}>
      <Ionicons name={name} size={20} color={color} />
    </View>
  );
};

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: touchTarget.minHeight + 8,
    paddingVertical: spacing.sm,
    gap: spacing.md,
  },
  pressed: {
    opacity: 0.6,
  },
  leading: {
    alignItems: "center",
    justifyContent: "center",
  },
  body: {
    flex: 1,
    justifyContent: "center",
  },
  subtitle: {
    marginTop: 2,
  },
  iconCircle: {
    width: 40,
    height: 40,
    borderRadius: radii.full,
    alignItems: "center",
    justifyContent: "center",
  },
});

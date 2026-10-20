import type { ReactNode } from "react";
import { Animated, Pressable, View, StyleSheet, type PressableProps } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, radii, sizes, spacing } from "../tokens";
import { usePressScale } from "./Motion";
import { Text } from "./Text";

/** `default` surface-2 tile + ink icon · `brand` green-50 + green-700 · `danger` red-50 + red-600 with a red title. */
export type ListRowTone = "default" | "brand" | "danger";

export interface ListRowProps extends Omit<PressableProps, "style" | "children"> {
  title: string;
  subtitle?: string;
  /** Leading element: an icon tile (`<ListRow.Icon />`), avatar or stop number. */
  leading?: ReactNode;
  /** Trailing element (value, status chip). Defaults to a chevron when `onPress` is set. */
  trailing?: ReactNode;
  showChevron?: boolean;
  tone?: ListRowTone;
  /** Draws the inset divider above this row (start it from the second row). */
  divider?: boolean;
  /** The spec's 16px side padding, for rows on a plain page rather than inside a card. */
  padded?: boolean;
}

/**
 * docs/design-system.md, "ListRow": flat 64px rows on surface with inset
 * line dividers, for places, settings, stops and history.
 */
export function ListRow({
  title,
  subtitle,
  leading,
  trailing,
  showChevron = true,
  tone = "default",
  divider = false,
  padded = false,
  onPress,
  onPressIn,
  onPressOut,
  ...rest
}: ListRowProps) {
  const { scale, pressIn, pressOut } = usePressScale(0.99);
  const pressable = Boolean(onPress);

  return (
    <Pressable
      accessibilityRole={pressable ? "button" : undefined}
      onPress={onPress}
      onPressIn={(e) => {
        if (pressable) pressIn();
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        if (pressable) pressOut();
        onPressOut?.(e);
      }}
      {...rest}
    >
      {({ pressed }) => (
        <Animated.View
          style={[
            styles.row,
            padded && styles.padded,
            pressed && pressable && styles.pressed,
            { transform: [{ scale }] },
          ]}
        >
          {divider ? (
            <View
              style={[
                styles.divider,
                { left: (padded ? spacing[4] : 0) + (leading ? sizes.avatarSm + spacing[4] : 0) },
              ]}
            />
          ) : null}
          {leading ? <View style={styles.leading}>{leading}</View> : null}
          <View style={styles.body}>
            <Text
              variant="bodyStrong"
              color={tone === "danger" ? "danger" : "default"}
              numberOfLines={1}
            >
              {title}
            </Text>
            {subtitle ? (
              <Text variant="subhead" color="secondary" numberOfLines={1} style={styles.subtitle}>
                {subtitle}
              </Text>
            ) : null}
          </View>
          {trailing ??
            (pressable && showChevron ? (
              <Ionicons name="chevron-forward" size={sizes.iconSm} color={colors.ink3} />
            ) : null)}
        </Animated.View>
      )}
    </Pressable>
  );
}

const TILE: Record<ListRowTone, { icon: string; fill: string }> = {
  default: { icon: colors.ink, fill: colors.surface2 },
  brand: { icon: colors.green700, fill: colors.green50 },
  danger: { icon: colors.red600, fill: colors.red50 },
};

/**
 * The 40px round leading tile with a 24px icon. Pick a `tone`; `color` and
 * `background` still override it for screens that set their own.
 */
ListRow.Icon = function ListRowIcon({
  name,
  tone = "default",
  color,
  background,
}: {
  name: keyof typeof Ionicons.glyphMap;
  tone?: ListRowTone;
  color?: string;
  background?: string;
}) {
  return (
    <View style={[styles.iconCircle, { backgroundColor: background ?? TILE[tone].fill }]}>
      <Ionicons name={name} size={sizes.icon} color={color ?? TILE[tone].icon} />
    </View>
  );
};

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 64,
    paddingVertical: spacing[2],
    gap: spacing[4],
    borderRadius: radii.md,
  },
  padded: {
    paddingHorizontal: spacing[4],
  },
  pressed: {
    backgroundColor: colors.surface2,
  },
  divider: {
    position: "absolute",
    top: 0,
    right: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.line,
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
    width: sizes.avatarSm,
    height: sizes.avatarSm,
    borderRadius: radii.full,
    alignItems: "center",
    justifyContent: "center",
  },
});

import type { GestureResponderEvent } from "react-native";
import {
  ActivityIndicator,
  Animated,
  Pressable,
  StyleSheet,
  View,
  type PressableProps,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { haptics } from "../haptics";
import { colors, radii, shadows, sizes, spacing } from "../tokens";
import { usePressScale } from "./Motion";
import { Text } from "./Text";

/**
 * docs/design-system.md, "Button". One `primary` per screen, then
 * `secondary` (tonal), `neutral`, `text`, `danger`. No outlined buttons.
 *
 * Older names still accepted: `ghost` renders as `text`, `dangerSecondary`
 * as `danger`.
 */
export type ButtonVariant =
  | "primary"
  | "secondary"
  | "neutral"
  | "text"
  | "danger"
  /** @deprecated Use text. */
  | "ghost"
  /** @deprecated Use danger. */
  | "dangerSecondary";

/** `lg` 56 (default), `md` 48, `pill` 36, `go` the driver's 64px round Go online / offline pill. */
export type ButtonSize = "lg" | "md" | "pill" | "go";

export interface ButtonProps extends Omit<PressableProps, "style" | "children"> {
  /** Verb first, sentence case: "Request Shared", "Cancel ride". */
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Optional leading Ionicons glyph. */
  icon?: keyof typeof Ionicons.glyphMap;
  loading?: boolean;
  /** Stretch to the container's width. Defaults to true, except for `pill` and `go`. */
  fullWidth?: boolean;
}

type Look = "primary" | "secondary" | "neutral" | "text" | "danger";

const LOOK: Record<ButtonVariant, Look> = {
  primary: "primary",
  secondary: "secondary",
  neutral: "neutral",
  text: "text",
  danger: "danger",
  ghost: "text",
  dangerSecondary: "danger",
};

const FILL: Record<Look, { rest: string; pressed: string }> = {
  primary: { rest: colors.green500, pressed: colors.green600 },
  secondary: { rest: colors.green50, pressed: colors.green100 },
  neutral: { rest: colors.surface2, pressed: colors.surface3 },
  text: { rest: "transparent", pressed: colors.surface2 },
  danger: { rest: "transparent", pressed: colors.red50 },
};

const LABEL: Record<Look, string> = {
  primary: colors.onBrand,
  secondary: colors.green700,
  neutral: colors.ink,
  text: colors.green700,
  danger: colors.red600,
};

const HEIGHT: Record<ButtonSize, number> = {
  lg: sizes.controlLg,
  md: sizes.controlMd,
  pill: sizes.controlSm,
  go: sizes.controlGo,
};

/** The one style for every tappable action. Disabled: surface-3 fill, ink-3 label; say why nearby. */
export function Button({
  label,
  variant = "primary",
  size = "lg",
  icon,
  loading = false,
  fullWidth,
  disabled,
  onPress,
  onPressIn,
  onPressOut,
  ...rest
}: ButtonProps) {
  const look = LOOK[variant];
  const isDisabled = Boolean(disabled || loading);
  const stretch = fullWidth ?? (size !== "pill" && size !== "go");
  const { scale, pressIn, pressOut } = usePressScale();
  // A disabled filled button turns surface-3; a text-style one keeps no fill.
  const filled = look === "primary" || look === "secondary" || look === "neutral";
  const labelColor = isDisabled && !loading ? colors.ink3 : LABEL[look];

  return (
    <Animated.View style={[stretch && styles.stretch, { transform: [{ scale }] }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled: isDisabled, busy: loading }}
        disabled={isDisabled}
        hitSlop={size === "pill" ? 6 : undefined}
        onPressIn={(e) => {
          pressIn();
          onPressIn?.(e);
        }}
        onPressOut={(e) => {
          pressOut();
          onPressOut?.(e);
        }}
        onPress={(e: GestureResponderEvent) => {
          if (look === "primary") haptics.impactLight();
          onPress?.(e);
        }}
        style={({ pressed }) => [
          styles.base,
          { minHeight: HEIGHT[size] },
          size === "go" || size === "pill" ? styles.round : null,
          size === "pill" || size === "md"
            ? styles.pillPadding
            : size === "go"
              ? styles.goPadding
              : null,
          stretch && styles.stretch,
          { backgroundColor: pressed && !isDisabled ? FILL[look].pressed : FILL[look].rest },
          isDisabled && filled && !loading && styles.disabledFill,
          size === "go" && styles.float,
        ]}
        {...rest}
      >
        {loading ? (
          <ActivityIndicator color={LABEL[look]} />
        ) : (
          <View style={styles.content}>
            {icon ? (
              <Ionicons name={icon} size={size === "pill" ? 18 : 20} color={labelColor} />
            ) : null}
            <Text
              variant={size === "pill" ? "subhead" : "button"}
              style={[styles.label, size === "pill" && styles.pillLabel, { color: labelColor }]}
              // Pills stay one line; a long label on a big button wraps rather than hiding words.
              numberOfLines={size === "pill" || size === "go" ? 1 : undefined}
            >
              {label}
            </Text>
          </View>
        )}
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: radii.md,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    paddingHorizontal: spacing[5],
  },
  stretch: {
    width: "100%",
  },
  round: {
    borderRadius: radii.full,
  },
  pillPadding: {
    paddingHorizontal: spacing[4],
  },
  goPadding: {
    paddingHorizontal: spacing[8],
  },
  content: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 1,
    gap: spacing[2],
    paddingVertical: spacing[2],
  },
  label: {
    textAlign: "center",
    flexShrink: 1,
  },
  pillLabel: {
    fontWeight: "700",
  },
  disabledFill: {
    backgroundColor: colors.surface3,
  },
  float: {
    ...shadows.float,
  },
});

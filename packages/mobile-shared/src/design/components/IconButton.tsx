import { Animated, Pressable, StyleSheet, View, type PressableProps } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, radii, shadows, sizes, spacing } from "../tokens";
import { usePressScale } from "./Motion";
import { Text } from "./Text";

/**
 * - `default`: the 56px surface-2 disc for round actions (Call, Message,
 *   Share trip, Safety), with its label underneath.
 * - `brand`: the same disc in green, for the one action that leads (Navigate).
 * - `map`: a 44px white disc floating on the map (recentre, back), no label.
 */
export type IconButtonVariant = "default" | "brand" | "map";

export interface IconButtonProps extends Omit<
  PressableProps,
  "style" | "children" | "accessibilityLabel"
> {
  icon: keyof typeof Ionicons.glyphMap;
  /** Required: what the button does, for VoiceOver / TalkBack. */
  accessibilityLabel: string;
  /** Short label under a `default` or `brand` disc. */
  label?: string;
  variant?: IconButtonVariant;
}

export function IconButton({
  icon,
  accessibilityLabel,
  label,
  variant = "default",
  disabled,
  onPressIn,
  onPressOut,
  ...rest
}: IconButtonProps) {
  const { scale, pressIn, pressOut } = usePressScale();
  const isMap = variant === "map";
  const discSize = isMap ? sizes.mapButton : sizes.iconButton;
  const iconColor = disabled ? colors.ink4 : variant === "brand" ? colors.onBrand : colors.ink;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      // The 44px map disc still gets a 48px target.
      hitSlop={isMap ? 2 : undefined}
      onPressIn={(e) => {
        pressIn();
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        pressOut();
        onPressOut?.(e);
      }}
      style={styles.wrap}
      {...rest}
    >
      {({ pressed }) => (
        <Animated.View style={[styles.column, { transform: [{ scale }] }]}>
          <View
            style={[
              styles.disc,
              { width: discSize, height: discSize },
              variant === "default" && {
                backgroundColor: pressed ? colors.surface3 : colors.surface2,
              },
              variant === "brand" && {
                backgroundColor: pressed ? colors.green600 : colors.green500,
              },
              isMap && [styles.map, pressed && { backgroundColor: colors.surface2 }],
            ]}
          >
            <Ionicons name={icon} size={isMap ? sizes.iconSm + 2 : sizes.icon} color={iconColor} />
          </View>
          {label && !isMap ? (
            <Text
              variant="caption"
              color={variant === "brand" ? "brand" : "secondary"}
              style={[styles.label, variant === "brand" && styles.brandLabel]}
              numberOfLines={1}
            >
              {label}
            </Text>
          ) : null}
        </Animated.View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: "center",
  },
  column: {
    alignItems: "center",
  },
  disc: {
    borderRadius: radii.full,
    alignItems: "center",
    justifyContent: "center",
  },
  map: {
    backgroundColor: colors.surface,
    ...shadows.float,
  },
  label: {
    marginTop: spacing[2],
  },
  brandLabel: {
    fontWeight: "700",
  },
});

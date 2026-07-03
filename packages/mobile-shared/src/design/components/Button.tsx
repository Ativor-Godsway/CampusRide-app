import { ActivityIndicator, StyleSheet } from "react-native";
import { colors, radii, spacing, touchTarget } from "../tokens";
import { Text } from "./Text";
import { AnimatedPressable, type AnimatedPressableProps } from "./AnimatedPressable";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "md" | "lg";

export interface ButtonProps extends Omit<AnimatedPressableProps, "style" | "children"> {
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  fullWidth?: boolean;
}

/**
 * Primary action surface — green pill with a pressed spring and a light
 * haptic on primary/danger actions. Always meets the minimum touch target.
 */
export function Button({
  label,
  variant = "primary",
  size = "md",
  loading = false,
  fullWidth = true,
  disabled,
  haptic,
  ...rest
}: ButtonProps) {
  const isDisabled = disabled || loading;

  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled }}
      disabled={isDisabled}
      haptic={haptic ?? (variant === "primary" || variant === "danger")}
      style={[
        styles.base,
        sizeStyles[size],
        variantStyles[variant],
        fullWidth && styles.fullWidth,
        isDisabled && styles.disabled,
      ]}
      {...rest}
    >
      {loading ? (
        <ActivityIndicator color={variant === "primary" || variant === "danger" ? colors.white : colors.primary[500]} />
      ) : (
        <Text variant="bodyMedium" color={textColor[variant]} style={styles.label}>
          {label}
        </Text>
      )}
    </AnimatedPressable>
  );
}

const textColor: Record<ButtonVariant, "inverse" | "primary" | "default"> = {
  primary: "inverse",
  secondary: "primary",
  ghost: "primary",
  danger: "inverse",
};

const styles = StyleSheet.create({
  base: {
    borderRadius: radii.pill,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    minHeight: touchTarget.minHeight,
    paddingHorizontal: spacing.xl,
  },
  fullWidth: {
    width: "100%",
  },
  label: {
    textAlign: "center",
  },
  disabled: {
    opacity: 0.4,
  },
});

const sizeStyles = StyleSheet.create({
  md: { minHeight: touchTarget.minHeight },
  lg: { minHeight: touchTarget.minHeight + 8, paddingHorizontal: spacing["2xl"] },
});

const variantStyles = StyleSheet.create({
  primary: { backgroundColor: colors.primary[500] },
  secondary: { backgroundColor: colors.white, borderWidth: 1.5, borderColor: colors.primary[500] },
  ghost: { backgroundColor: "transparent" },
  danger: { backgroundColor: colors.danger },
});

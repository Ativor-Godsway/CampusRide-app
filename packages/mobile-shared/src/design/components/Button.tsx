import { ActivityIndicator, Pressable, StyleSheet, type PressableProps } from "react-native";
import { colors, radii, shadows, spacing, touchTarget } from "../tokens";
import { Text } from "./Text";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "md" | "lg";

export interface ButtonProps extends Omit<PressableProps, "style" | "children"> {
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  fullWidth?: boolean;
}

/** Primary action surface. Always meets the 48px minimum touch target. */
export function Button({
  label,
  variant = "primary",
  size = "md",
  loading = false,
  fullWidth = true,
  disabled,
  ...rest
}: ButtonProps) {
  const isDisabled = disabled || loading;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled }}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.base,
        sizeStyles[size],
        variantStyles[variant],
        fullWidth && styles.fullWidth,
        isDisabled && styles.disabled,
        pressed && !isDisabled && styles.pressed,
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
    </Pressable>
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
    borderRadius: radii.md,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    minHeight: touchTarget.minHeight,
    paddingHorizontal: spacing.lg,
  },
  fullWidth: {
    width: "100%",
  },
  label: {
    textAlign: "center",
  },
  pressed: {
    opacity: 0.85,
  },
  disabled: {
    opacity: 0.5,
  },
});

const sizeStyles = StyleSheet.create({
  md: { minHeight: touchTarget.minHeight },
  lg: { minHeight: touchTarget.minHeight + 8, paddingHorizontal: spacing.xl },
});

const variantStyles = StyleSheet.create({
  primary: { backgroundColor: colors.primary[500], ...shadows.brand },
  secondary: { backgroundColor: colors.white, borderWidth: 1.5, borderColor: colors.primary[200] },
  ghost: { backgroundColor: "transparent" },
  danger: { backgroundColor: colors.danger, ...shadows.sm },
});

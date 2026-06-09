import { View, StyleSheet, type ViewProps } from "react-native";
import { colors, radii, spacing } from "../tokens";
import { Text } from "./Text";

export type BadgeVariant = "default" | "soon" | "success" | "error" | "warning" | "accent";

export interface BadgeProps extends ViewProps {
  label: string;
  variant?: BadgeVariant;
}

/** Small status pill — used for "Soon" tags on upcoming services and payment/ride status. */
export function Badge({ label, variant = "default", style, ...rest }: BadgeProps) {
  const variantStyle = variantStyles[variant];
  return (
    <View style={[styles.base, variantStyle.container, style]} {...rest}>
      <Text variant="caption" style={variantStyle.text}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: radii.full,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    alignSelf: "flex-start",
  },
});

const variantStyles: Record<BadgeVariant, { container: object; text: object }> = {
  default: {
    container: { backgroundColor: colors.surfaceMuted },
    text: { color: colors.ink[600] },
  },
  soon: {
    container: { backgroundColor: colors.ink[50] },
    text: { color: colors.ink[400] },
  },
  success: {
    container: { backgroundColor: colors.successSurface },
    text: { color: colors.success },
  },
  error: {
    container: { backgroundColor: colors.errorSurface },
    text: { color: colors.error },
  },
  warning: {
    container: { backgroundColor: colors.warningSurface },
    text: { color: colors.warning },
  },
  accent: {
    container: { backgroundColor: colors.accent[50] },
    text: { color: colors.accent[600] },
  },
};

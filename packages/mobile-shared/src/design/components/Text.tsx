import { Text as RNText, type TextProps as RNTextProps, StyleSheet } from "react-native";
import { colors, typography } from "../tokens";

export type TextVariant =
  | "display"
  | "h1"
  | "h2"
  | "h3"
  | "body"
  | "bodyMedium"
  | "bodySmall"
  | "caption"
  | "label";

export type TextColor = "default" | "muted" | "inverse" | "primary" | "error" | "success";

export interface TextComponentProps extends RNTextProps {
  variant?: TextVariant;
  color?: TextColor;
}

const variantStyles = StyleSheet.create({
  display: {
    fontSize: typography.size["4xl"],
    fontWeight: typography.weight.bold,
    lineHeight: typography.size["4xl"] * typography.lineHeight.tight,
  },
  h1: {
    fontSize: typography.size["3xl"],
    fontWeight: typography.weight.bold,
    lineHeight: typography.size["3xl"] * typography.lineHeight.tight,
  },
  h2: {
    fontSize: typography.size["2xl"],
    fontWeight: typography.weight.bold,
    lineHeight: typography.size["2xl"] * typography.lineHeight.tight,
  },
  h3: {
    fontSize: typography.size.xl,
    fontWeight: typography.weight.semibold,
    lineHeight: typography.size.xl * typography.lineHeight.normal,
  },
  body: {
    fontSize: typography.size.md,
    fontWeight: typography.weight.regular,
    lineHeight: typography.size.md * typography.lineHeight.normal,
  },
  bodyMedium: {
    fontSize: typography.size.md,
    fontWeight: typography.weight.medium,
    lineHeight: typography.size.md * typography.lineHeight.normal,
  },
  bodySmall: {
    fontSize: typography.size.sm,
    fontWeight: typography.weight.regular,
    lineHeight: typography.size.sm * typography.lineHeight.normal,
  },
  caption: {
    fontSize: typography.size.xs,
    fontWeight: typography.weight.medium,
    lineHeight: typography.size.xs * typography.lineHeight.normal,
  },
  label: {
    fontSize: typography.size.sm,
    fontWeight: typography.weight.semibold,
    lineHeight: typography.size.sm * typography.lineHeight.normal,
  },
});

const colorStyles: Record<TextColor, { color: string }> = {
  default: { color: colors.ink[900] },
  muted: { color: colors.ink[400] },
  inverse: { color: colors.white },
  primary: { color: colors.primary[500] },
  error: { color: colors.error },
  success: { color: colors.success },
};

/** Type-scale-bound text component. Use `variant` for size/weight and `color` for the semantic palette — avoid ad-hoc font sizes elsewhere. */
export function Text({ variant = "body", color = "default", style, ...rest }: TextComponentProps) {
  return <RNText style={[variantStyles[variant], colorStyles[color], style]} {...rest} />;
}

import {
  Text as RNText,
  type TextProps as RNTextProps,
  type TextStyle,
  StyleSheet,
} from "react-native";
import { fonts } from "../fonts";
import { colors, textStyles, type TextStyleName } from "../tokens";

/**
 * The spec's type scale (docs/design-system.md, "Type"), plus the older
 * names screens still use. Each old name renders as the closest spec style.
 */
export type TextVariant =
  | TextStyleName
  /** @deprecated Use title1. */
  | "h1"
  /** @deprecated Use title2. */
  | "h2"
  /** @deprecated Use title3. */
  | "h3"
  /** @deprecated Use bodyStrong. */
  | "bodyMedium"
  /** @deprecated Use subhead. */
  | "bodySmall"
  /** @deprecated Use subhead (semibold labels) or eyebrow (uppercase section labels). */
  | "label"
  /** @deprecated Use plate, or `tabular` for numbers. */
  | "mono";

export type TextColor =
  | "default"
  | "secondary"
  | "tertiary"
  | "brand"
  | "onBrand"
  | "onDark"
  | "onDark2"
  | "greenOnDark"
  | "danger"
  | "warning"
  /** @deprecated Use secondary. */
  | "muted"
  /** @deprecated Use tertiary. */
  | "subtle"
  /** @deprecated Use onBrand or onDark. */
  | "inverse"
  /** @deprecated Use brand. */
  | "primary"
  /** @deprecated Use warning. */
  | "accent"
  /** @deprecated Use danger. */
  | "error"
  /** @deprecated Use brand. */
  | "success"
  /** @deprecated Use greenOnDark. */
  | "glow";

export interface TextComponentProps extends RNTextProps {
  variant?: TextVariant;
  color?: TextColor;
  /** Same-width digits, for money, ETAs, countdowns and codes. */
  tabular?: boolean;
}

const variantStyles = StyleSheet.create({
  ...textStyles,
  h1: textStyles.title1,
  h2: textStyles.title2,
  h3: textStyles.title3,
  bodyMedium: textStyles.bodyStrong,
  bodySmall: textStyles.subhead,
  label: { ...textStyles.subhead, fontFamily: fonts.semibold },
  mono: { fontFamily: fonts.extrabold, fontSize: 16, lineHeight: 22, letterSpacing: 0.6 },
});

/** Big numbers grow with Dynamic Type only up to 1.3x, so they don't break layouts. */
const CAPPED: ReadonlySet<TextVariant> = new Set(["display", "title1", "plate", "h1", "mono"]);
const DISPLAY_FONT_SCALE_CAP = 1.3;

const colorValues: Record<TextColor, string> = {
  default: colors.ink,
  secondary: colors.ink2,
  tertiary: colors.ink3,
  brand: colors.green700,
  onBrand: colors.onBrand,
  onDark: colors.onDark,
  onDark2: colors.onDark2,
  greenOnDark: colors.greenOnDark,
  danger: colors.red600,
  warning: colors.amber700,
  muted: colors.ink2,
  subtle: colors.ink3,
  inverse: colors.onDark,
  primary: colors.green500,
  accent: colors.amber700,
  error: colors.red600,
  success: colors.green500,
  glow: colors.greenOnDark,
};

const FAMILY_BY_WEIGHT: Record<string, string> = {
  "100": fonts.regular,
  "200": fonts.regular,
  "300": fonts.regular,
  "400": fonts.regular,
  normal: fonts.regular,
  "500": fonts.medium,
  "600": fonts.semibold,
  "700": fonts.bold,
  bold: fonts.bold,
  "800": fonts.extrabold,
  "900": fonts.extrabold,
};

const FIGTREE: ReadonlySet<string> = new Set(Object.values(fonts));

/**
 * Figtree has one family per weight. A `fontWeight` (a variant's, or one a
 * screen still sets) becomes that weight's family and is dropped, since a
 * fontWeight on a custom font makes Android fake-bold it. A non-Figtree
 * fontFamily (system monospace, say) is left as it is.
 */
export function resolveFigtree(style: TextStyle): TextStyle {
  const family = style.fontFamily;
  if (family && !FIGTREE.has(family)) return style;
  const weight = style.fontWeight != null ? String(style.fontWeight) : undefined;
  const resolved = (weight && FAMILY_BY_WEIGHT[weight]) || family || fonts.regular;
  if (resolved === family && style.fontWeight == null) return style;
  return { ...style, fontFamily: resolved, fontWeight: undefined };
}

/**
 * Type-scale-bound text. Use `variant` for the style and `color` for the
 * palette; avoid ad-hoc font sizes elsewhere.
 */
export function Text({
  variant = "body",
  color = "default",
  tabular = false,
  maxFontSizeMultiplier,
  style,
  ...rest
}: TextComponentProps) {
  const flat = StyleSheet.flatten([
    variantStyles[variant],
    { color: colorValues[color] },
    tabular && styles.tabular,
    style,
  ]);
  return (
    <RNText
      maxFontSizeMultiplier={
        maxFontSizeMultiplier ?? (CAPPED.has(variant) ? DISPLAY_FONT_SCALE_CAP : undefined)
      }
      style={resolveFigtree(flat)}
      {...rest}
    />
  );
}

const styles = StyleSheet.create({
  tabular: { fontVariant: ["tabular-nums"] },
});

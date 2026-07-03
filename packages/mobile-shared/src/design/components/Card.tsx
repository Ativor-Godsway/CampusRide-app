import { View, StyleSheet, type ViewProps } from "react-native";
import { colors, radii, shadows, spacing } from "../tokens";

export interface CardProps extends ViewProps {
  /** Removes padding for cards that manage their own inner layout. */
  noPadding?: boolean;
  elevated?: boolean;
  /** Deep near-black "feature card" treatment for selective emphasis — use sparingly. */
  dark?: boolean;
  /** @deprecated The decorative corner glow was retired with the redesign (no decorative shapes). Accepted as a no-op so existing callers keep compiling. */
  glow?: boolean;
}

/** Surface container — the basic building block for tiles, list rows, and grouped content. */
export function Card({ noPadding, elevated = true, dark = false, glow: _glow, style, children, ...rest }: CardProps) {
  return (
    <View
      style={[
        styles.base,
        dark ? styles.dark : styles.light,
        elevated && shadows.md,
        !noPadding && styles.padded,
        style,
      ]}
      {...rest}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: radii.lg,
  },
  light: {
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
  },
  dark: {
    backgroundColor: colors.surfaceDark,
    borderWidth: 1,
    borderColor: colors.borderDark,
  },
  padded: {
    padding: spacing.lg,
  },
});

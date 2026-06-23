import { View, StyleSheet, type ViewProps } from "react-native";
import { colors, radii, shadows, spacing } from "../tokens";

export interface CardProps extends ViewProps {
  /** Removes padding for cards that manage their own inner layout. */
  noPadding?: boolean;
  elevated?: boolean;
  /** Deep near-black "feature card" treatment for selective emphasis — use sparingly. */
  dark?: boolean;
  /**
   * Decorative radial-green glow bleeding from the top-right corner — the
   * "signature dark card" treatment. Defaults to `true` whenever `dark` is
   * set; pass `glow={false}` to opt a specific dark card out. No-op when
   * `dark` is false. Implemented as a clipped translucent circle (no
   * gradient library in the tree) — purely decorative, no layout impact.
   */
  glow?: boolean;
}

/** Surface container — the basic building block for tiles, list rows, and grouped content. */
export function Card({ noPadding, elevated = true, dark = false, glow, style, children, ...rest }: CardProps) {
  const showGlow = dark && (glow ?? true);
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
      {/* Absolutely-positioned clipping layer, sibling to children (not wrapping
          them) — overflow:hidden on the shadow-bearing outer view itself would
          clip the shadow on iOS, and wrapping children would break any `gap`/
          `flexDirection` a caller passes via `style` for arranging them. */}
      {showGlow && (
        <View pointerEvents="none" style={styles.clip}>
          <View style={styles.glow} />
        </View>
      )}
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
  clip: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: radii.lg,
    overflow: "hidden",
  },
  glow: {
    position: "absolute",
    top: -60,
    right: -60,
    width: 180,
    height: 180,
    borderRadius: 90,
    backgroundColor: "rgba(25, 116, 60, 0.35)",
  },
});

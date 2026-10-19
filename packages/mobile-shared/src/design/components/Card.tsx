import { View, StyleSheet, type ViewProps } from "react-native";
import { colors, radii, shadows, spacing, withAlpha } from "../tokens";

/**
 * docs/design-system.md, "Card": cards group facts with a fill, not a shadow.
 * - `filled`: surface-2 on a white page.
 * - `float`: white with shadow-float, only when floating on the map.
 * - `dark`: surface-dark, once per screen, for a hero number.
 */
export type CardVariant = "filled" | "float" | "dark";

export interface CardProps extends ViewProps {
  /** Pick one in new code. Without it the card is the older white card with a hairline border. */
  variant?: CardVariant;
  /** Removes padding for cards that manage their own inner layout. */
  noPadding?: boolean;
  /** @deprecated Cards don't take a shadow on white; use variant="float" on the map. Ignored. */
  elevated?: boolean;
  /** @deprecated Use variant="dark". */
  dark?: boolean;
  /**
   * @deprecated The older dark card's green corner glow; on by default for
   * `dark`, off for `variant="dark"`. Purely decorative.
   */
  glow?: boolean;
}

export function Card({
  variant,
  noPadding,
  elevated: _elevated,
  dark = false,
  glow,
  style,
  children,
  ...rest
}: CardProps) {
  const look = variant ?? (dark ? "legacyDark" : "legacy");
  const showGlow = look === "legacyDark" && (glow ?? true);
  return (
    <View style={[styles.base, styles[look], !noPadding && styles.padded, style]} {...rest}>
      {/* Absolutely-positioned clipping layer, sibling to children (not wrapping
          them) — overflow:hidden on the outer view would clip a float shadow
          on iOS, and wrapping children would break any `gap`/`flexDirection`
          a caller passes via `style`. */}
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
  filled: {
    backgroundColor: colors.surface2,
  },
  float: {
    backgroundColor: colors.surface,
    ...shadows.float,
  },
  dark: {
    backgroundColor: colors.surfaceDark,
  },
  legacy: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
  },
  legacyDark: {
    backgroundColor: colors.surfaceDark,
  },
  padded: {
    padding: spacing[4],
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
    backgroundColor: withAlpha(colors.green500, 0.35),
  },
});

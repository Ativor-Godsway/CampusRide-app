import { View, StyleSheet, type ViewProps } from "react-native";
import { colors, radii, shadows, spacing } from "../tokens";

export interface CardProps extends ViewProps {
  /** Removes padding for cards that manage their own inner layout. */
  noPadding?: boolean;
  elevated?: boolean;
}

/** Surface container — the basic building block for tiles, list rows, and grouped content. */
export function Card({ noPadding, elevated = true, style, children, ...rest }: CardProps) {
  return (
    <View
      style={[styles.base, elevated && shadows.sm, !noPadding && styles.padded, style]}
      {...rest}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    backgroundColor: colors.white,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  padded: {
    padding: spacing.lg,
  },
});

import { StyleSheet, View, type ViewProps } from "react-native";
import { colors, radii, spacing } from "../tokens";
import { StatusChip, type StatusTone } from "./Chip";
import { Text } from "./Text";

/** @deprecated Use StatusChip tones: brand / neutral / warn / danger / amber. */
export type BadgeVariant = "default" | "soon" | "success" | "error" | "warning" | "accent" | "live";

export interface BadgeProps extends ViewProps {
  label: string;
  variant?: BadgeVariant;
}

const TONE: Record<Exclude<BadgeVariant, "live">, StatusTone> = {
  default: "neutral",
  soon: "neutral",
  success: "brand",
  error: "danger",
  warning: "warn",
  accent: "warn",
};

/** @deprecated Use StatusChip. Each old variant renders as the closest tone. */
export function Badge({ label, variant = "default", style, ...rest }: BadgeProps) {
  if (variant === "live") {
    // White on ink, for a status chip on a photo or the map.
    return (
      <View style={[styles.live, style]} {...rest}>
        <Text variant="caption" color="onDark" style={styles.liveLabel}>
          {label}
        </Text>
      </View>
    );
  }
  return <StatusChip label={label} tone={TONE[variant]} style={style} {...rest} />;
}

const styles = StyleSheet.create({
  live: {
    alignSelf: "flex-start",
    justifyContent: "center",
    minHeight: 24,
    paddingHorizontal: spacing[2],
    borderRadius: radii.sm,
    backgroundColor: colors.surfaceDark,
  },
  liveLabel: {
    fontWeight: "700",
  },
});

import { Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, radii, spacing, typography } from "../../design/tokens";
import { Text } from "../../design/components/Text";

export interface AuthHeroProps {
  title: string;
  subtitle?: string;
  /** Smaller hero with a back button — used by OTP/signup steps. */
  compact?: boolean;
  onBack?: () => void;
}

/**
 * Branded green hero treatment shared across the auth flow — gives the
 * sign-in/sign-up/OTP screens a distinctive "front door" identity instead
 * of a plain centered form.
 */
export function AuthHero({ title, subtitle, compact = false, onBack }: AuthHeroProps) {
  return (
    <View style={[styles.hero, compact ? styles.heroCompact : styles.heroFull]}>
      <View style={styles.blobOne} />
      <View style={styles.blobTwo} />

      {onBack ? (
        <Pressable
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={styles.backButton}
        >
          <Ionicons name="arrow-back" size={22} color={colors.white} />
        </Pressable>
      ) : null}

      <View style={styles.content}>
        {!compact ? (
          <View style={styles.wordmarkRow}>
            <View style={styles.logoBadge}>
              <Ionicons name="navigate" size={20} color={colors.primary[600]} />
            </View>
            <Text style={styles.wordmark}>CampusRide</Text>
          </View>
        ) : null}
        <Text style={compact ? styles.titleCompact : styles.title}>{title}</Text>
        {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  hero: {
    backgroundColor: colors.primary[600],
    overflow: "hidden",
    justifyContent: "flex-end",
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing["2xl"],
  },
  heroFull: {
    minHeight: 300,
  },
  heroCompact: {
    minHeight: 180,
  },
  blobOne: {
    position: "absolute",
    top: -90,
    right: -60,
    width: 220,
    height: 220,
    borderRadius: radii.full,
    backgroundColor: colors.primary[500],
    opacity: 0.55,
  },
  blobTwo: {
    position: "absolute",
    bottom: -70,
    left: -50,
    width: 160,
    height: 160,
    borderRadius: radii.full,
    backgroundColor: colors.primary[700],
    opacity: 0.5,
  },
  backButton: {
    position: "absolute",
    top: spacing.lg,
    left: spacing.lg,
    width: 40,
    height: 40,
    borderRadius: radii.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.16)",
  },
  content: {
    gap: spacing.xs,
  },
  wordmarkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginBottom: spacing.lg,
  },
  logoBadge: {
    width: 32,
    height: 32,
    borderRadius: radii.full,
    backgroundColor: colors.white,
    alignItems: "center",
    justifyContent: "center",
  },
  wordmark: {
    color: colors.white,
    fontSize: typography.size.lg,
    fontWeight: typography.weight.bold,
    letterSpacing: typography.letterSpacing.tight,
  },
  title: {
    color: colors.white,
    fontSize: typography.size["3xl"],
    fontWeight: typography.weight.extrabold,
    letterSpacing: typography.letterSpacing.tighter,
    lineHeight: typography.size["3xl"] * 1.15,
  },
  titleCompact: {
    color: colors.white,
    fontSize: typography.size["2xl"],
    fontWeight: typography.weight.extrabold,
    letterSpacing: typography.letterSpacing.tight,
  },
  subtitle: {
    color: "rgba(255,255,255,0.85)",
    fontSize: typography.size.md,
    lineHeight: typography.size.md * 1.4,
    marginTop: spacing.xs,
  },
});

import { useRouter } from "expo-router";
import { StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import Animated, {
  withDelay,
  withTiming,
  type EntryAnimationsValues,
} from "react-native-reanimated";
import {
  AnimatedPressable,
  Text,
  brand,
  colors,
  motion,
  onBrand,
  radii,
  spacing,
  typography,
} from "@rida/mobile-shared";
import { Logomark } from "../components/Logomark";

/** Staggered entrance: translateY 12 → 0 + fade, once on mount. */
function enterUp(delay: number) {
  return (_: EntryAnimationsValues) => {
    "worklet";
    return {
      initialValues: { opacity: 0, transform: [{ translateY: 12 }] },
      animations: {
        opacity: withDelay(delay, withTiming(1, { duration: motion.duration.base })),
        transform: [{ translateY: withDelay(delay, withTiming(0, { duration: motion.duration.base })) }],
      },
    };
  };
}

/** Welcome — the logged-out front door. Both actions lead to phone entry; only the OTP purpose differs. */
export default function WelcomeScreen() {
  const router = useRouter();

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <Animated.View entering={enterUp(0)} style={styles.badgeWrap}>
          <View style={styles.badge}>
            <Text variant="caption" style={styles.badgeText}>
              UNIVERSITY OF GHANA · LEGON
            </Text>
          </View>
        </Animated.View>

        <View style={styles.body}>
          <Animated.View entering={enterUp(80)}>
            <Logomark size={64} />
          </Animated.View>
          <Animated.Text entering={enterUp(160)} style={styles.title}>
            Your campus, one tap away.
          </Animated.Text>
          <Animated.Text entering={enterUp(240)} style={styles.copy}>
            Shared rides at a flat GHS 5. Private rides at GHS 15. No surge, ever.
          </Animated.Text>
        </View>

        <Animated.View entering={enterUp(320)} style={styles.actions}>
          <AnimatedPressable
            accessibilityRole="button"
            haptic
            onPress={() => router.push({ pathname: "/auth/phone", params: { purpose: "SIGNUP" } })}
            style={styles.primaryAction}
          >
            <Text variant="bodyMedium" style={styles.primaryActionText}>
              Get started
            </Text>
          </AnimatedPressable>
          <AnimatedPressable
            accessibilityRole="button"
            onPress={() => router.push({ pathname: "/auth/phone", params: { purpose: "LOGIN" } })}
            style={styles.ghostAction}
          >
            <Text variant="bodyMedium" style={styles.ghostActionText}>
              I already have an account
            </Text>
          </AnimatedPressable>
        </Animated.View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: brand.primary,
  },
  safe: {
    flex: 1,
    paddingHorizontal: spacing.gutter,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
  },
  badgeWrap: {
    alignItems: "center",
  },
  badge: {
    borderWidth: 1,
    borderColor: onBrand.border,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
  },
  badgeText: {
    color: onBrand.secondary,
    fontFamily: typography.fontFamily.mono,
    letterSpacing: typography.letterSpacing.wide,
  },
  body: {
    flex: 1,
    justifyContent: "flex-end",
    gap: spacing.lg,
    paddingBottom: spacing["2xl"],
  },
  title: {
    color: colors.white,
    fontSize: typography.size.display,
    lineHeight: 40,
    fontWeight: typography.weight.extrabold,
    letterSpacing: typography.letterSpacing.tighter,
  },
  copy: {
    color: onBrand.secondary,
    fontSize: typography.size.md,
    lineHeight: typography.size.md * typography.lineHeight.normal,
  },
  actions: {
    gap: spacing.sm,
  },
  primaryAction: {
    backgroundColor: colors.white,
    borderRadius: radii.pill,
    minHeight: 52,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryActionText: {
    color: colors.ink[900],
  },
  ghostAction: {
    minHeight: 52,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.pill,
  },
  ghostActionText: {
    color: colors.white,
  },
});

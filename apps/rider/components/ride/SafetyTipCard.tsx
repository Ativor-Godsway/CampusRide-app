import { useEffect, useRef, useState } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import { Illustration, Text, colors, radii, spacing, useReduceMotion } from "@rida/mobile-shared";

export const SAFETY_TIPS = [
  "Check the car's plate matches before you get in.",
  "Share your trip from the SOS button if you ever feel unsafe.",
  "Add an emergency contact in Account → Safety.",
] as const;

const ROTATE_MS = 6000;
const FADE_MS = 280;

/**
 * A calm, rotating safety tip for the wait. Crossfades every 6s; with
 * Reduce Motion on, the tip still changes but swaps instantly.
 */
export function SafetyTipCard() {
  const reduceMotion = useReduceMotion();
  const [index, setIndex] = useState(0);
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const timer = setInterval(() => {
      if (reduceMotion) {
        setIndex((i) => (i + 1) % SAFETY_TIPS.length);
        return;
      }
      Animated.timing(opacity, {
        toValue: 0,
        duration: FADE_MS,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (!finished) return;
        setIndex((i) => (i + 1) % SAFETY_TIPS.length);
        Animated.timing(opacity, {
          toValue: 1,
          duration: FADE_MS,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true,
        }).start();
      });
    }, ROTATE_MS);
    return () => clearInterval(timer);
  }, [opacity, reduceMotion]);

  return (
    <View style={styles.card} accessible accessibilityLabel={`Safety tip: ${SAFETY_TIPS[index]}`}>
      <Illustration name="safetyShield" size={44} />
      <View style={styles.body}>
        <Text variant="label" color="primary">
          SAFETY TIP
        </Text>
        <Animated.View style={{ opacity }}>
          <Text variant="bodySmall">{SAFETY_TIPS[index]}</Text>
        </Animated.View>
        <View style={styles.dots} importantForAccessibility="no-hide-descendants">
          {SAFETY_TIPS.map((tip, i) => (
            <View key={tip} style={[styles.dot, i === index && styles.dotActive]} />
          ))}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radii.lg,
    backgroundColor: colors.primary[50],
  },
  body: { flex: 1, gap: 4 },
  dots: { flexDirection: "row", gap: 4, marginTop: 2 },
  dot: { width: 5, height: 5, borderRadius: 3, backgroundColor: colors.primary[200] },
  dotActive: { width: 14, backgroundColor: colors.primary[500] },
});

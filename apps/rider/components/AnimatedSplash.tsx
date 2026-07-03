import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text } from "react-native";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";
import { brand, colors, motion, onBrand, spacing, typography } from "@rida/mobile-shared";
import { Logomark } from "./Logomark";

/** Splash stays up at least this long so the entrance reads, even on instant auth resolution. */
const MIN_SPLASH_MS = 900;
const EXIT_MS = 300;

/** Static route-line texture — thin curved paths at 8% white. No animation loops. */
function RouteTexture() {
  return (
    <Svg
      style={StyleSheet.absoluteFill}
      viewBox="0 0 390 844"
      preserveAspectRatio="xMidYMid slice"
      pointerEvents="none"
    >
      <Path
        d="M -40 180 C 80 120, 180 260, 300 190 S 460 120, 520 200"
        stroke={onBrand.texture}
        strokeWidth={1.5}
        fill="none"
      />
      <Path
        d="M -60 420 C 60 360, 140 500, 260 430 S 420 350, 500 450"
        stroke={onBrand.texture}
        strokeWidth={1.5}
        fill="none"
      />
      <Path
        d="M -40 660 C 90 600, 170 740, 290 670 S 440 600, 520 690"
        stroke={onBrand.texture}
        strokeWidth={1.5}
        fill="none"
      />
      <Path
        d="M 60 -40 C 120 120, 40 260, 130 400 S 220 640, 150 900"
        stroke={onBrand.texture}
        strokeWidth={1.5}
        fill="none"
      />
    </Svg>
  );
}

export interface AnimatedSplashProps {
  /** True once the auth gate has resolved — the splash exits when this AND the minimum display time are both met. */
  ready: boolean;
  /** Called after the exit animation completes. */
  onFinished: () => void;
}

/**
 * Full-bleed brand-green JS splash. The native splash (expo-splash-screen,
 * same green) hands off to this on first frame; the logomark springs in,
 * the wordmark follows 120ms later, and the whole thing slides up and fades
 * once the auth gate has resolved. Never delays auth — the gate runs in
 * parallel and this only holds the *visual*.
 */
export function AnimatedSplash({ ready, onFinished }: AnimatedSplashProps) {
  const [minElapsed, setMinElapsed] = useState(false);
  const exiting = useRef(false);

  const logoScale = useSharedValue(0.8);
  const logoOpacity = useSharedValue(0);
  const wordOpacity = useSharedValue(0);
  const wordY = useSharedValue(8);
  const containerY = useSharedValue(0);
  const containerOpacity = useSharedValue(1);

  useEffect(() => {
    // Native splash (same green) is up until our first frame — swap seamlessly.
    void SplashScreen.hideAsync().catch(() => {});
    logoScale.value = withSpring(1, motion.spring.gentle);
    logoOpacity.value = withTiming(1, { duration: motion.duration.base });
    wordOpacity.value = withDelay(120, withTiming(1, { duration: motion.duration.base }));
    wordY.value = withDelay(120, withTiming(0, { duration: motion.duration.base }));
    const t = setTimeout(() => setMinElapsed(true), MIN_SPLASH_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!ready || !minElapsed || exiting.current) return;
    exiting.current = true;
    containerY.value = withTiming(-48, { duration: EXIT_MS });
    containerOpacity.value = withTiming(0, { duration: EXIT_MS }, (finished) => {
      if (finished) runOnJS(onFinished)();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, minElapsed]);

  const containerStyle = useAnimatedStyle(() => ({
    opacity: containerOpacity.value,
    transform: [{ translateY: containerY.value }],
  }));
  const logoStyle = useAnimatedStyle(() => ({
    opacity: logoOpacity.value,
    transform: [{ scale: logoScale.value }],
  }));
  const wordStyle = useAnimatedStyle(() => ({
    opacity: wordOpacity.value,
    transform: [{ translateY: wordY.value }],
  }));

  return (
    <Animated.View style={[styles.root, containerStyle]}>
      <StatusBar style="light" />
      <RouteTexture />
      <Animated.View style={logoStyle}>
        <Logomark size={84} />
      </Animated.View>
      <Animated.View style={wordStyle}>
        <Text style={styles.wordmark}>CampusRide</Text>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: brand.primary,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.lg,
  },
  wordmark: {
    color: colors.white,
    fontSize: typography.size.xl,
    fontWeight: typography.weight.bold,
    letterSpacing: typography.letterSpacing.tight,
  },
});

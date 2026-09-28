import { useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Image,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { colors } from "../tokens";
import { illustrations, type IllustrationName } from "../illustrations";

export interface IllustrationProps {
  /** Which artwork to show. See `design/illustrations.ts`. */
  name: IllustrationName;
  /** Square size in points. Defaults to 140. */
  size?: number;
  /** Gentle up-and-down float with a soft shadow underneath. */
  float?: boolean;
  /** Radar-style rings pulsing out from behind the art ("waiting" states). */
  pulse?: boolean;
  /** Springy pop-in on mount, for celebrations (trip complete). */
  pop?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}

/** True when the user turned on Reduce Motion in their phone settings. */
export function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => mounted && setReduce(v));
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduce);
    return () => {
      mounted = false;
      sub.remove();
    };
  }, []);
  return reduce;
}

/**
 * A 3D illustration with subtle, premium motion. Uses React Native's built-in
 * Animated (native driver), so it's Expo Go safe and costs nothing on the JS
 * thread. All motion is skipped when Reduce Motion is on.
 */
export function Illustration({
  name,
  size = 140,
  float = false,
  pulse = false,
  pop = false,
  style,
  accessibilityLabel,
}: IllustrationProps) {
  const reduceMotion = useReduceMotion();
  const enter = useRef(new Animated.Value(0)).current;
  const bob = useRef(new Animated.Value(0)).current;
  const ring = useRef(new Animated.Value(0)).current;

  // Entrance: fade + slight scale (or a springy pop).
  useEffect(() => {
    if (reduceMotion) {
      enter.setValue(1);
      return;
    }
    const anim = pop
      ? Animated.spring(enter, { toValue: 1, friction: 5, tension: 80, useNativeDriver: true })
      : Animated.timing(enter, {
          toValue: 1,
          duration: 420,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        });
    anim.start();
    return () => anim.stop();
  }, [enter, pop, reduceMotion]);

  // Float loop.
  useEffect(() => {
    if (!float || reduceMotion) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(bob, { toValue: 1, duration: 1600, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(bob, { toValue: 0, duration: 1600, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [bob, float, reduceMotion]);

  // Pulse rings loop.
  useEffect(() => {
    if (!pulse || reduceMotion) return;
    const loop = Animated.loop(
      Animated.timing(ring, { toValue: 1, duration: 2400, easing: Easing.out(Easing.quad), useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [ring, pulse, reduceMotion]);

  const lift = Math.max(4, Math.round(size * 0.045));
  const translateY = bob.interpolate({ inputRange: [0, 1], outputRange: [0, -lift] });
  const shadowScale = bob.interpolate({ inputRange: [0, 1], outputRange: [1, 0.86] });
  const shadowOpacity = bob.interpolate({ inputRange: [0, 1], outputRange: [1, 0.7] });
  const enterScale = enter.interpolate({ inputRange: [0, 1], outputRange: [pop ? 0.6 : 0.94, 1] });

  const renderRing = (offset: number) => {
    const progress = Animated.modulo(Animated.add(ring, offset), 1);
    return (
      <Animated.View
        key={offset}
        pointerEvents="none"
        style={[
          styles.ring,
          {
            width: size * 0.9,
            height: size * 0.9,
            borderRadius: size,
            opacity: progress.interpolate({ inputRange: [0, 0.15, 1], outputRange: [0, 0.45, 0] }),
            transform: [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.55, 1.45] }) }],
          },
        ]}
      />
    );
  };

  return (
    <Animated.View
      style={[
        { width: size, height: size + (float ? lift * 2 : 0), alignItems: "center", justifyContent: "center" },
        { opacity: enter, transform: [{ scale: enterScale }] },
        style,
      ]}
      accessible={Boolean(accessibilityLabel)}
      accessibilityRole={accessibilityLabel ? "image" : undefined}
      accessibilityLabel={accessibilityLabel}
      importantForAccessibility={accessibilityLabel ? "yes" : "no-hide-descendants"}
    >
      {pulse && !reduceMotion ? (
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          <View style={styles.ringCenter}>{[0, 0.5].map(renderRing)}</View>
        </View>
      ) : null}

      {float ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.shadow,
            {
              width: size * 0.5,
              height: Math.max(6, size * 0.06),
              bottom: 0,
              opacity: reduceMotion ? 1 : shadowOpacity,
              transform: [{ scaleX: reduceMotion ? 1 : shadowScale }],
            },
          ]}
        />
      ) : null}

      <Animated.View style={{ transform: [{ translateY: float && !reduceMotion ? translateY : 0 }] }}>
        <Image source={illustrations[name]} style={{ width: size, height: size }} resizeMode="contain" />
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  ring: {
    position: "absolute",
    borderWidth: 2,
    borderColor: colors.primary[300],
    backgroundColor: "rgba(108,192,137,0.08)",
  },
  ringCenter: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  shadow: {
    position: "absolute",
    borderRadius: 999,
    backgroundColor: "rgba(15,19,17,0.10)",
  },
});

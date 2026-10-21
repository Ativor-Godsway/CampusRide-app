import { useEffect, useRef, useState } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { Text, colors } from "@rida/mobile-shared";

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

const secondsBetween = (from: number, to: number) => Math.max(0, Math.ceil((to - from) / 1000));

/**
 * The offer's countdown: a green ring on green-100 that empties from full to
 * nothing by `deadline`, with the seconds left in the middle (tabular).
 * Linear on purpose — it is a clock — and it keeps counting with Reduce
 * Motion on (it's information, not decoration). `frozenAt` stops it where it
 * was (Accept tapped, the claim is on its way).
 */
export function CountdownRing({
  deadline,
  totalMs,
  frozenAt,
  size = 56,
  stroke = 5,
}: {
  /** Epoch ms when the offer times out. */
  deadline: number;
  /** The whole countdown, for how full the ring starts. */
  totalMs: number;
  /** Epoch ms to stop at, or undefined while it runs. */
  frozenAt?: number;
  size?: number;
  stroke?: number;
}) {
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const progress = useRef(new Animated.Value(0)).current;
  const [secondsLeft, setSecondsLeft] = useState(() =>
    secondsBetween(frozenAt ?? Date.now(), deadline),
  );

  useEffect(() => {
    const at = frozenAt ?? Date.now();
    const left = Math.max(0, deadline - at);
    progress.setValue(1 - left / Math.max(1, totalMs));
    setSecondsLeft(secondsBetween(at, deadline));
    if (frozenAt !== undefined) return;
    const anim = Animated.timing(progress, {
      toValue: 1,
      duration: left,
      easing: Easing.linear,
      useNativeDriver: false,
    });
    anim.start();
    const t = setInterval(() => setSecondsLeft(secondsBetween(Date.now(), deadline)), 250);
    return () => {
      anim.stop();
      clearInterval(t);
    };
  }, [deadline, totalMs, frozenAt, progress]);

  return (
    <View
      style={{ width: size, height: size }}
      accessible
      accessibilityRole="timer"
      accessibilityLabel={`${secondsLeft} seconds left to accept`}
    >
      <Svg width={size} height={size}>
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={colors.green100}
          strokeWidth={stroke}
          fill="none"
        />
        <AnimatedCircle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={colors.green500}
          strokeWidth={stroke}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={`${circumference} ${circumference}`}
          strokeDashoffset={progress.interpolate({
            inputRange: [0, 1],
            outputRange: [0, circumference],
          })}
          // Start at 12 o'clock and run clockwise.
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <View style={styles.center}>
          <Text variant="title3" tabular style={{ fontSize: size * 0.34 }}>
            {secondsLeft}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
});

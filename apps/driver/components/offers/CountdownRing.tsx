import { useEffect, useRef, useState } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { Text, colors, typography } from "@rida/mobile-shared";

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/**
 * The offer's countdown: a ring that empties from full to nothing by
 * `deadline`, with the seconds left in the middle. Linear on purpose — it
 * is a clock. It keeps counting with Reduce Motion on (it's information,
 * not decoration); only the card's slide-in is skipped then.
 */
export function CountdownRing({
  deadline,
  totalMs,
  size = 64,
  stroke = 5,
  color = colors.primary[500],
}: {
  /** Epoch ms when the offer times out. */
  deadline: number;
  /** The whole countdown, for how full the ring starts. */
  totalMs: number;
  size?: number;
  stroke?: number;
  color?: string;
}) {
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const progress = useRef(new Animated.Value(0)).current;
  const [secondsLeft, setSecondsLeft] = useState(() => Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));

  useEffect(() => {
    const left = Math.max(0, deadline - Date.now());
    progress.setValue(1 - left / Math.max(1, totalMs));
    const anim = Animated.timing(progress, { toValue: 1, duration: left, easing: Easing.linear, useNativeDriver: false });
    anim.start();
    const t = setInterval(() => setSecondsLeft(Math.max(0, Math.ceil((deadline - Date.now()) / 1000))), 250);
    return () => {
      anim.stop();
      clearInterval(t);
    };
  }, [deadline, totalMs, progress]);

  const urgent = secondsLeft <= 5;
  return (
    <View
      style={{ width: size, height: size }}
      accessible
      accessibilityRole="timer"
      accessibilityLabel={`${secondsLeft} seconds left to accept`}
    >
      <Svg width={size} height={size}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={colors.border} strokeWidth={stroke} fill="none" />
        <AnimatedCircle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={urgent ? colors.warning : color}
          strokeWidth={stroke}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={`${circumference} ${circumference}`}
          strokeDashoffset={progress.interpolate({ inputRange: [0, 1], outputRange: [0, circumference] })}
          // Start at 12 o'clock and run clockwise.
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <View style={styles.center}>
          <Text style={[styles.seconds, { fontSize: size * 0.32 }, urgent && styles.urgent]}>{secondsLeft}</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  seconds: { fontWeight: typography.weight.extrabold, color: colors.ink[900], fontVariant: ["tabular-nums"] },
  urgent: { color: colors.warning },
});

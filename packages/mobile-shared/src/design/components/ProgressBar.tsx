import { useEffect, useRef } from "react";
import { Animated, StyleSheet, View } from "react-native";
import { colors, motion } from "../tokens";

export interface ProgressBarProps {
  /** 0-1 progress value. Animates smoothly between updates. */
  progress: number;
  color?: string;
  trackColor?: string;
  height?: number;
}

/**
 * Animated horizontal progress indicator — used by R3's waiting/searching
 * screen to show dispatch-timeout progress. Built on `Animated` (no
 * reanimated dependency needed), so it's Expo Go safe.
 */
export function ProgressBar({
  progress,
  color = colors.primary[500],
  trackColor = colors.surfaceMuted,
  height = 6,
}: ProgressBarProps) {
  const widthAnim = useRef(new Animated.Value(progress)).current;

  useEffect(() => {
    Animated.timing(widthAnim, {
      toValue: Math.max(0, Math.min(1, progress)),
      duration: motion.duration.normal,
      useNativeDriver: false,
    }).start();
  }, [progress, widthAnim]);

  return (
    <View style={[styles.track, { backgroundColor: trackColor, height, borderRadius: height / 2 }]}>
      <Animated.View
        style={[
          styles.fill,
          {
            backgroundColor: color,
            height,
            borderRadius: height / 2,
            width: widthAnim.interpolate({
              inputRange: [0, 1],
              outputRange: ["0%", "100%"],
              extrapolate: "clamp",
            }),
          },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    width: "100%",
    overflow: "hidden",
  },
  fill: {
    height: "100%",
  },
});

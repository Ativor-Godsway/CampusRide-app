import { useEffect } from "react";
import { StyleSheet } from "react-native";
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { colors } from "../tokens";

export interface CaretProps {
  height?: number;
  color?: string;
}

/** Blinking input caret for keypad-driven fields (no TextInput = no native caret). Loop is cancelled on unmount. */
export function Caret({ height = 24, color = colors.primary[500] }: CaretProps) {
  const opacity = useSharedValue(1);

  useEffect(() => {
    opacity.value = withRepeat(withTiming(0, { duration: 530 }), -1, true);
    return () => cancelAnimation(opacity);
  }, [opacity]);

  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return <Animated.View style={[styles.caret, { height, backgroundColor: color }, style]} />;
}

const styles = StyleSheet.create({
  caret: {
    width: 2,
    borderRadius: 1,
  },
});

import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { motion } from "../tokens";
import { haptics } from "../haptics";

const AnimatedPressableBase = Animated.createAnimatedComponent(Pressable);

export interface AnimatedPressableProps extends Omit<PressableProps, "style"> {
  /** Static style only (no Pressable style-function form) — pressed feedback is handled by the spring. */
  style?: StyleProp<ViewStyle>;
  /** Scale when pressed. Defaults to 0.97; keypad keys use 0.94. */
  pressedScale?: number;
  /** Fires a light haptic on press. */
  haptic?: boolean;
}

/**
 * The one pressed-state used across the app: springs to `pressedScale` +
 * slight opacity dip on touch-down, springs back on release. Transform/
 * opacity only, driven on the UI thread.
 */
export function AnimatedPressable({
  style,
  pressedScale = 0.97,
  haptic = false,
  disabled,
  onPressIn,
  onPressOut,
  onPress,
  ...rest
}: AnimatedPressableProps) {
  const pressed = useSharedValue(0);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + pressed.value * (pressedScale - 1) }],
    opacity: 1 - pressed.value * 0.12,
  }));

  return (
    <AnimatedPressableBase
      disabled={disabled}
      onPressIn={(e) => {
        pressed.value = withSpring(1, motion.spring.snappy);
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        pressed.value = withSpring(0, motion.spring.snappy);
        onPressOut?.(e);
      }}
      onPress={(e) => {
        if (haptic) haptics.light();
        onPress?.(e);
      }}
      style={[animatedStyle, style]}
      {...rest}
    />
  );
}
